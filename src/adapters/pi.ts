import type { AdapterResult, Conversation, TranscriptMessage } from "../model";
import { buildConversation, metadataFromCwd, roleFrom, type SessionMeta } from "./common";
import { readJsonl, walkFiles } from "./jsonl";
import { extractText, parseTimestamp, sourcePathToSessionId, stringValue } from "../utils";

export async function discoverPi(root = `${process.env.HOME ?? ""}/.pi/agent/sessions`): Promise<AdapterResult> {
  const files = await walkFiles(root, (path) => path.endsWith(".jsonl"));
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
        const timestamp = parseTimestamp(record.timestamp);
        if (record.type === "session") {
          sessionId ??= stringValue(record.id);
          meta = { ...meta, ...metadataFromCwd(record.cwd), createdAt: timestamp };
          continue;
        }
        if (record.type !== "message") continue;
        const message = record.message;
        if (!message || typeof message !== "object") continue;
        const messageRecord = message as Record<string, unknown>;
        const role = roleFrom(messageRecord.role);
        if (!role) continue;
        const text = extractText(messageRecord.content);
        if (!text.trim()) continue;
        const messageTimestamp = parseTimestamp(messageRecord.timestamp) ?? timestamp;
        messages.push({ role, text, timestamp: messageTimestamp });
        meta.updatedAt = messageTimestamp ?? meta.updatedAt;
      }
      sessionId ??= sourcePathToSessionId(path);
      const conversation = buildConversation("pi", sessionId, path, meta, messages, title);
      if (conversation) conversations.push(conversation);
      if (parsed.trailingLineIgnored) warnings.push({ provider: "pi", sourcePath: path, message: "ignored incomplete trailing JSONL line; it will be retried next run" });
    } catch (error) {
      failures.push({ provider: "pi", sourcePath: path, message: (error as Error).message });
    }
  }
  return { provider: "pi", conversations, scanned: files.length, warnings, failures };
}
