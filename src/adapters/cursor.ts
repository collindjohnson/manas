import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AdapterResult, AdapterWarning, Conversation, TranscriptMessage } from "../model";
import { buildConversation, metadataFromCwd, roleFrom, type SessionMeta } from "./common";
import { walkFiles } from "./jsonl";
import { extractText, parseTimestamp, stringValue } from "../utils";

interface CursorCandidate {
  sourceId: string;
  title?: string;
  meta: SessionMeta;
  messages: TranscriptMessage[];
}

function decodeValue(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  if (value instanceof Uint8Array) {
    const text = new TextDecoder().decode(value);
    try { return JSON.parse(text); } catch { return text; }
  }
  return value;
}

function sourceIdFromKey(key: string): string {
  const match = key.match(/(?:composerData|conversation|session|agent)[/:]([^/:]+)$/i);
  return match?.[1] ?? key;
}

function textField(record: Record<string, unknown>): string {
  return extractText(record.text ?? record.content ?? record.message ?? record.parts);
}

function collectMessages(value: unknown): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const seen = new Set<string>();
  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    const role = roleFrom(record.role ?? record.sender ?? record.author);
    if (role) {
      const text = textField(record);
      if (text.trim()) {
        const timestamp = parseTimestamp(record.timestamp ?? record.createdAt ?? record.created_at);
        const identity = `${role}\0${timestamp ?? ""}\0${text}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          messages.push({ role, text, timestamp });
        }
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (["toolCall", "toolResult", "toolCalls", "toolResults", "thinking", "reasoning"].includes(key)) continue;
      if (child && typeof child === "object") visit(child);
    }
  }
  visit(value);
  return messages;
}

function candidateFromValue(key: string, value: unknown): CursorCandidate | undefined {
  const root = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sourceId = stringValue(root.conversationId, root.composerId, root.sessionId, root.agentId, root.id) ?? sourceIdFromKey(key);
  const title = stringValue(root.title, root.name, root.conversationTitle);
  const cwd = stringValue(root.workspacePath, root.workspace, root.cwd, root.projectPath, root.folderPath);
  const messages = collectMessages(value);
  if (!messages.length) return undefined;
  return { sourceId, title, meta: metadataFromCwd(cwd), messages };
}

function readDatabase(path: string): CursorCandidate[] {
  const database = new Database(path, { readonly: true });
  try {
    const tables = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const candidates: CursorCandidate[] = [];
    for (const table of tables) {
      if (table.name !== "cursorDiskKV" && table.name !== "ItemTable") continue;
      const rows = database.query<{ key: string; value: unknown }, []>(`SELECT key, value FROM "${table.name}"`).all();
      for (const row of rows) {
        const value = decodeValue(row.value);
        const candidate = candidateFromValue(row.key, value);
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates;
  } finally {
    database.close();
  }
}

export async function discoverCursor(root = `${process.env.HOME ?? ""}/Library/Application Support/Cursor`): Promise<AdapterResult> {
  const files = await walkFiles(root, (path) => basename(path) === "state.vscdb");
  const grouped = new Map<string, CursorCandidate>();
  const warnings: AdapterWarning[] = [];
  const failures = [];
  for (const path of files) {
    try {
      for (const candidate of readDatabase(path)) {
        const sourceKey = candidate.sourceId;
        const existing = grouped.get(sourceKey);
        if (!existing) grouped.set(sourceKey, { ...candidate, messages: [...candidate.messages] });
        else {
          existing.messages.push(...candidate.messages);
          existing.title ??= candidate.title;
          existing.meta = { ...candidate.meta, ...existing.meta };
        }
      }
    } catch (error) {
      failures.push({ provider: "cursor", sourcePath: path, message: (error as Error).message });
    }
  }
  const conversations: Conversation[] = [];
  for (const [sourceId, candidate] of grouped) {
    const seen = new Set<string>();
    const messages = candidate.messages.filter((message) => {
      const identity = `${message.role}\0${message.timestamp ?? ""}\0${message.text}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    const conversation = buildConversation("cursor", sourceId, root, candidate.meta, messages, candidate.title);
    if (conversation) conversations.push(conversation);
  }
  return { provider: "cursor", conversations, scanned: files.length, warnings, failures };
}

export function cursorDatabasePath(root: string, relative: string): string {
  return join(root, relative);
}
