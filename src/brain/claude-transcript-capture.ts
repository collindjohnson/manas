import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertManagedParents } from "../agent-management";
import { capturePolicy, CaptureError, stageCaptureTurn, enqueueCaptureTurn } from "./memory-capture";
import { enqueueJob, recordJobEvent, renewJobLease, updateJobProgress, type BrainJob } from "./jobs";
import type { BrainStore } from "./store";
import type { BrainRepository } from "./repository";

const PAGE_BYTES = 512 * 1024, MAX_LINE = 8 * 1024 * 1024, MAX_FILE = 1024 * 1024 * 1024;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fail(message: string): never { throw new CaptureError("transcript_capture_unavailable", message, "Inspect the Claude capture job and its selected transcript boundary; repair or retry the source without deleting canonical memories."); }
export interface ClaudeTranscriptInput { installationId: string; sessionId: string; transcriptPath: string; }
interface TranscriptPage extends ClaudeTranscriptInput { brainId: string; limit: number; identity: string; epoch: string; startOffset: number; scanId: string; }
async function transcript(stateRoot: string, input: ClaudeTranscriptInput) {
 const policy = await capturePolicy(stateRoot, input.installationId);
 if (!policy.captureEnabled || policy.agent !== "claude-code") return fail("Claude transcript capture is not enabled.");
 if (typeof input.sessionId !== "string" || !input.sessionId.trim() || input.sessionId.length > 256 || typeof input.transcriptPath !== "string" || !isAbsolute(input.transcriptPath) || input.transcriptPath.length > 4096 || !input.transcriptPath.endsWith(".jsonl")) return fail("Claude capture needs a stable session and a JSONL transcript path.");
 await assertManagedParents(input.transcriptPath);
 const selectedRoot = await realpath(join(policy.home, ".claude", "projects"));
 const path = resolve(input.transcriptPath), canonical = await realpath(path);
 const within = relative(selectedRoot, canonical);
 const info = await lstat(path, { bigint: true });
 if (within.startsWith("..") || isAbsolute(within) || !within || canonical !== await realpath(path) || !info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== BigInt(process.getuid()))) return fail("Transcript is outside the selected Claude projects or is not an owned regular file.");
 if (info.size > BigInt(MAX_FILE)) return fail("Transcript exceeds the one GiB capture scan budget.");
 return { policy, path: canonical, info, identity: info.dev.toString() + ":" + info.ino.toString() };
}
export async function enqueueClaudeTranscript(store: BrainStore, stateRoot: string, input: ClaudeTranscriptInput, brainId: string) {
 const source = await transcript(stateRoot, input);
 const scanId = hash(JSON.stringify([input.installationId, source.policy.captureEpoch, brainId, input.sessionId, source.path, source.identity, source.info.size.toString(), source.info.mtimeNs.toString()]));
 const payload: TranscriptPage = { ...input, transcriptPath: source.path, brainId, limit: Number(source.info.size), identity: source.identity, epoch: source.policy.captureEpoch!, startOffset: 0, scanId };
 const job = await enqueueJob(store, { type: "claude-transcript-capture", payload, idempotencyKey: "claude-scan:" + scanId, priority: -1 });
 return { jobId: job.id, status: job.status };
}
function userTurn(value: unknown, sessionId: string, enabledAt: string): { turnId: string; prompt: string; observedAt: string } | undefined {
 if (!value || typeof value !== "object" || Array.isArray(value)) return fail("Transcript contains a non-object JSONL record.");
 const record = value as Record<string, unknown>;
 if (record.type !== "user" || record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true || record.isSynthetic === true) return;
 const message = record.message as { role?: unknown; content?: unknown } | undefined;
 if (!message || message.role !== "user") return;
 const content = message.content;
 if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) return;
 const prompt = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
 if (!prompt.trim()) return;
 if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) return fail("A user transcript record has no valid observation timestamp.");
 if (Date.parse(record.timestamp) < Date.parse(enabledAt)) return;
 if (record.sessionId !== sessionId || typeof record.uuid !== "string" || !record.uuid.trim() || record.uuid.length > 256) return fail("A selected user record has no matching session and stable message UUID.");
 if (prompt.length > 16000) return fail("A user prompt exceeds the 16000 character capture budget; use explicit capture for this record.");
 return { turnId: record.uuid, prompt, observedAt: record.timestamp };
}
export function claudeTranscriptHandler(options: { store: BrainStore; repository: BrainRepository; stateRoot: string; workerId: string }) {
 return async (job: BrainJob) => {
  const input = job.payload as TranscriptPage;
  if (!input || job.tenantId !== "local" || input.brainId !== (await options.repository.getIdentity()).brainId || !Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > MAX_FILE || !Number.isSafeInteger(input.startOffset) || input.startOffset < 0 || input.startOffset > input.limit || !/^[a-f0-9]{64}$/.test(input.scanId)) return fail("Transcript job scope or bounds are invalid.");
  const source = await transcript(options.stateRoot, input);
  if (source.policy.captureEpoch !== input.epoch || source.identity !== input.identity || source.info.size < BigInt(input.limit)) return fail("Transcript identity, capture grant, or frozen boundary changed; enqueue a new reconciliation.");
  await renewJobLease(options.store, job.id, options.workerId, 60000, new Date(), job.tenantId);
  let offset = typeof job.progress?.byteOffset === "number" ? job.progress.byteOffset : input.startOffset;
  if (!Number.isSafeInteger(offset) || offset < input.startOffset || offset > input.limit) return fail("Transcript checkpoint is invalid.");
  const file = await open(source.path, "r");
  try {
   const info = await file.stat({ bigint: true });
   if (info.dev.toString() + ":" + info.ino.toString() !== input.identity || info.size < BigInt(input.limit)) return fail("Transcript changed while opening the snapshot.");
   const maximum = Math.min(input.limit - offset, PAGE_BYTES + MAX_LINE + 1);
   const bytes = Buffer.alloc(maximum);
   let read = 0;
   while (read < maximum) {
    const part = await file.read(bytes, read, maximum - read, offset + read);
    if (!part.bytesRead) return fail("Transcript was truncated during capture.");
    read += part.bytesRead;
   }
   let cursor = 0, records = 0, staged = 0;
   const decoder = new TextDecoder("utf-8", { fatal: true });
   while (cursor < bytes.length && records < 1000 && staged < 100) {
    const newline = bytes.indexOf(10, cursor);
    if (newline < 0) {
     if (bytes.length - cursor > MAX_LINE || offset + bytes.length < input.limit) return fail("Transcript record exceeds the eight MiB scan budget.");
     break; // Leave an incomplete tail for a later Stop reconciliation.
    }
    if (newline - cursor > MAX_LINE) return fail("Transcript record exceeds the eight MiB scan budget.");
    const line = decoder.decode(bytes.subarray(cursor, newline));
    if (line.trim()) {
     let value: unknown;
     try { value = JSON.parse(line); } catch { return fail("Transcript contains malformed JSON before its trailing boundary."); }
     const turn = userTurn(value, input.sessionId, source.policy.captureEnabledAt!);
     if (turn) {
      await renewJobLease(options.store, job.id, options.workerId, 60000, new Date(), job.tenantId);
      await stageCaptureTurn(options.store, options.stateRoot, { installationId: input.installationId, sessionId: input.sessionId, ...turn }, input.brainId);
      await enqueueCaptureTurn(options.store, options.stateRoot, { installationId: input.installationId, sessionId: input.sessionId, turnId: turn.turnId }, input.brainId);
      staged++;
     }
    }
    cursor = newline + 1; records++;
    await updateJobProgress(options.store, job.id, options.workerId, { byteOffset: offset + cursor, frozenLimit: input.limit }, job.tenantId);
    if (cursor >= PAGE_BYTES) break;
   }
   offset += cursor;
   if (offset < input.limit && cursor && (cursor >= PAGE_BYTES || records >= 1000 || staged >= 100)) {
    await enqueueJob(options.store, { type: job.type, payload: { ...input, startOffset: offset }, priority: -1, idempotencyKey: "claude-page:" + input.scanId + ":" + offset });
   }
   await recordJobEvent(options.store, { jobId: job.id, tenantId: job.tenantId, eventType: "capture.transcript.page", metadata: { byteOffset: offset, frozenLimit: input.limit, records, staged, incompleteTail: offset < input.limit && (!cursor || cursor < PAGE_BYTES && records < 1000 && staged < 100) } });
  } finally { await file.close(); }
 };
}
