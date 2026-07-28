import type { AdapterResult, Conversation, TranscriptMessage } from "../model";
import { buildConversation, metadataFromCwd, roleFrom, type SessionMeta } from "./common";
import { readJsonl, walkFiles } from "./jsonl";
import { extractText, parseTimestamp, sourcePathToSessionId, stringValue } from "../utils";

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function discoverCodex(root = `${process.env.HOME ?? ""}/.codex`): Promise<AdapterResult> {
  const files = [
    ...(await walkFiles(`${root}/sessions`, (path) => path.endsWith(".jsonl"))),
    ...(await walkFiles(`${root}/archived_sessions`, (path) => path.endsWith(".jsonl"))),
  ].sort();
  const conversations: Conversation[] = [];
  const warnings = [];
  const failures = [];
  for (const path of files) {
    try {
      const parsed = await readJsonl(path);
      let sessionId: string | undefined;
      let title: string | undefined;
      let meta: SessionMeta = {};
      const messages: TranscriptMessage[] = [];
      for (const record of parsed.records) {
        const recordType = stringValue(record.type);
        const timestamp = parseTimestamp(record.timestamp);
        if (recordType === "session_meta") {
          const payload = nestedRecord(record.payload) ?? record;
          sessionId ??= stringValue(payload.id, payload.sessionId, record.sessionId);
          const cwd = stringValue(payload.cwd, payload.workspacePath);
          meta = { ...meta, ...metadataFromCwd(cwd), createdAt: parseTimestamp(payload.timestamp) ?? timestamp };
          continue;
        }
        if (recordType === "ai-title" || recordType === "title") {
          title = stringValue(record.aiTitle, record.title);
          continue;
        }
        let event: Record<string, unknown> | undefined;
        if (recordType === "response_item") event = nestedRecord(record.payload);
        else if (recordType === "event_msg") event = nestedRecord(record.payload);
        else if (recordType === "message") event = record;
        else if (recordType === "user_message" || recordType === "agent_message") event = record;
        if (!event) continue;
        const eventType = stringValue(event.type, recordType);
        let role = roleFrom(event.role);
        let content: unknown = event.content;
        if (eventType === "user_message") {
          role = "user";
          content = event.message ?? event.content;
        } else if (eventType === "agent_message") {
          role = "assistant";
          content = event.message ?? event.content;
        }
        if (!role || eventType === "developer_message" || eventType === "system_message") continue;
        if (role === "assistant" && event.phase !== undefined && event.phase !== "final_answer") continue;
        const text = extractText(content);
        if (!text.trim()) continue;
        messages.push({ role, text, timestamp: parseTimestamp(event.timestamp) ?? timestamp });
        meta.updatedAt = parseTimestamp(event.timestamp) ?? timestamp ?? meta.updatedAt;
      }
      sessionId ??= sourcePathToSessionId(path);
      const conversation = buildConversation("codex", sessionId, path, meta, messages, title);
      if (conversation) conversations.push(conversation);
      if (parsed.trailingLineIgnored) warnings.push({ provider: "codex", sourcePath: path, message: "ignored incomplete trailing JSONL line; it will be retried next run" });
    } catch (error) {
      failures.push({ provider: "codex", sourcePath: path, message: (error as Error).message });
    }
  }
  return { provider: "codex", conversations, scanned: files.length, warnings, failures };
}
