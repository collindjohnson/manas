import { join } from "node:path";
import type { AdapterResult, Conversation, TranscriptMessage } from "../model";
import { buildConversation, metadataFromCwd, type SessionMeta } from "./common";
import { readJsonl, walkFiles } from "./jsonl";
import { extractText, parseTimestamp, stringValue } from "../utils";

export async function discoverGrok(root = `${process.env.HOME ?? ""}/.grok/sessions`): Promise<AdapterResult> {
  const summaries = await walkFiles(root, (path) => path.endsWith("summary.json"));
  const conversations: Conversation[] = [];
  const warnings = [];
  const failures = [];
  for (const summaryPath of summaries) {
    try {
      const summaryValue: unknown = await Bun.file(summaryPath).json();
      const summary = summaryValue && typeof summaryValue === "object" ? summaryValue as Record<string, unknown> : {};
      const info = (summary.info && typeof summary.info === "object" ? summary.info : summary) as Record<string, unknown>;
      const sessionId = stringValue(info.id, info.sessionId);
      if (!sessionId) throw new Error("summary has no session id");
      const updatesPath = join(summaryPath, "..", "updates.jsonl");
      const messages: TranscriptMessage[] = [];
      let trailingLineIgnored = false;
      try {
        const updates = await readJsonl(updatesPath);
        trailingLineIgnored = updates.trailingLineIgnored;
        for (const record of updates.records) {
          const params = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : record;
          const update = params.update;
          const updateRecord = update && typeof update === "object" ? update as Record<string, unknown> : undefined;
          const directUpdate = record.update && typeof record.update === "object" ? record.update as Record<string, unknown> : undefined;
          const updateType = stringValue(updateRecord?.sessionUpdate, directUpdate?.sessionUpdate);
          const content = updateRecord?.content;
          const text = extractText(content);
          if (!text.trim()) continue;
          let role: "user" | "assistant" | undefined;
          if (updateType === "user_message_chunk") role = "user";
          else if (updateType === "agent_message_chunk" || updateType === "agent_message") role = "assistant";
          if (!role) continue;
          messages.push({ role, text, timestamp: parseTimestamp(record.timestamp) });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        warnings.push({ provider: "grok", sourcePath: updatesPath, message: "summary found without updates.jsonl" });
      }
      const cwd = stringValue(info.cwd, info.workspacePath);
      const meta: SessionMeta = {
        ...metadataFromCwd(cwd),
        createdAt: parseTimestamp(info.created_at ?? info.createdAt),
        updatedAt: parseTimestamp(info.updated_at ?? info.updatedAt ?? info.last_active_at),
        repository: stringValue(info.git_root_dir) ?? metadataFromCwd(cwd).repository,
        repositoryUrl: Array.isArray(info.git_remotes) ? stringValue(info.git_remotes[0]) : undefined,
      };
      const conversation = buildConversation(
        "grok",
        sessionId,
        summaryPath,
        meta,
        messages,
        stringValue(info.generated_title, info.session_summary, info.title),
      );
      if (conversation) conversations.push(conversation);
      if (trailingLineIgnored) warnings.push({ provider: "grok", sourcePath: updatesPath, message: "ignored incomplete trailing JSONL line; it will be retried next run" });
    } catch (error) {
      failures.push({ provider: "grok", sourcePath: summaryPath, message: (error as Error).message });
    }
  }
  return { provider: "grok", conversations, scanned: summaries.length, warnings, failures };
}
