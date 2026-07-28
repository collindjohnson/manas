import type { AdapterResult, Conversation, TranscriptMessage } from "../model";
import { buildConversation, metadataFromCwd, roleFrom } from "./common";
import { readJsonl, walkFiles } from "./jsonl";
import { extractText, sourcePathToSessionId, stringValue } from "../utils";

export async function discoverClaudeCode(root = `${process.env.HOME ?? ""}/.claude/projects`): Promise<AdapterResult> {
  const files = await walkFiles(root, (path) => path.endsWith(".jsonl"));
  const conversations: Conversation[] = [];
  const warnings = [];
  const failures = [];
  for (const path of files) {
    try {
      const parsed = await readJsonl(path);
      const sessionId = parsed.records.map((record) => stringValue(record.sessionId)).find(Boolean) ?? sourcePathToSessionId(path);
      const cwd = parsed.records.map((record) => stringValue(record.cwd)).find(Boolean);
      const messages: TranscriptMessage[] = [];
      let title: string | undefined;
      let createdAt: string | undefined;
      let updatedAt: string | undefined;
      for (const record of parsed.records) {
        const type = stringValue(record.type);
        if (type === "ai-title") title = stringValue(record.aiTitle, record.title);
        const role = type === "user" || type === "assistant" ? roleFrom(type) : undefined;
        if (!role || record.isMeta === true || record.isSidechain === true) continue;
        const message = record.message;
        if (!message || typeof message !== "object") continue;
        const messageRecord = message as Record<string, unknown>;
        const content = messageRecord.content;
        if (typeof content !== "string" && !Array.isArray(content) && (!content || typeof content !== "object")) continue;
        const extracted = typeof content === "string" ? content : extractText(content);
        if (!extracted.trim()) continue;
        const timestamp = stringValue(record.timestamp, messageRecord.timestamp);
        messages.push({ role, text: extracted, timestamp });
        createdAt ??= timestamp;
        updatedAt = timestamp ?? updatedAt;
      }
      const conversation = buildConversation(
        "claude_code",
        sessionId,
        path,
        { ...metadataFromCwd(cwd), createdAt, updatedAt },
        messages,
        title,
      );
      if (conversation) conversations.push(conversation);
      if (parsed.trailingLineIgnored) warnings.push({ provider: "claude_code", sourcePath: path, message: "ignored incomplete trailing JSONL line; it will be retried next run" });
    } catch (error) {
      failures.push({ provider: "claude_code", sourcePath: path, message: (error as Error).message });
    }
  }
  return { provider: "claude_code", conversations, scanned: files.length, warnings, failures };
}
