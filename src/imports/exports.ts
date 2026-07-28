import type { Conversation, Provider, TranscriptMessage } from "../model";
import { buildConversation, metadataFromCwd, roleFrom } from "../adapters/common";
import { extractText, parseTimestamp, stringValue } from "../utils";
import { readExportJson } from "./zip";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
  const record = asRecord(value);
  if (record?.conversations && Array.isArray(record.conversations)) return asList(record.conversations);
  return [];
}

function chatgptMessages(conversation: Record<string, unknown>): TranscriptMessage[] {
  const mapping = asRecord(conversation.mapping);
  if (!mapping) return [];
  const currentNode = stringValue(conversation.current_node);
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let nodeId = currentNode;
  while (nodeId && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    const nodeRecord = asRecord(node);
    if (!nodeRecord) break;
    branch.push(nodeRecord);
    nodeId = stringValue(nodeRecord.parent) ?? "";
  }
  const source = branch.length ? branch.reverse() : Object.values(mapping).map(asRecord).filter((value): value is Record<string, unknown> => Boolean(value));
  return source.flatMap((node) => {
    const message = asRecord(node.message);
    if (!message) return [];
    const role = roleFrom(asRecord(message.author)?.role);
    if (!role) return [];
    const content = asRecord(message.content);
    const parts = content?.parts;
    const text = extractText(parts ?? message.content);
    if (!text.trim()) return [];
    return [{ role, text, timestamp: parseTimestamp(message.create_time ?? node.create_time) }];
  });
}

function claudeMessages(conversation: Record<string, unknown>): TranscriptMessage[] {
  const raw = conversation.chat_messages ?? conversation.messages ?? conversation.chatMessages;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const message = asRecord(item);
    if (!message) return [];
    const role = roleFrom(message.sender ?? message.role ?? asRecord(message.author)?.role);
    if (!role) return [];
    const text = extractText(message.text ?? message.content ?? message.parts);
    if (!text.trim()) return [];
    return [{ role, text, timestamp: parseTimestamp(message.created_at ?? message.createdAt ?? message.timestamp) }];
  });
}

function exportConversations(provider: Provider, value: unknown, sourcePath: string): Conversation[] {
  const conversations = asList(value);
  const result: Conversation[] = [];
  for (const conversation of conversations) {
    const sourceId = stringValue(conversation.id, conversation.uuid, conversation.conversation_id, conversation.conversationId);
    if (!sourceId) continue;
    const isChatgpt = provider === "chatgpt";
    const messages = isChatgpt ? chatgptMessages(conversation) : claudeMessages(conversation);
    const metadata = metadataFromCwd(stringValue(conversation.cwd, conversation.workspace_path, conversation.project_path));
    const built = buildConversation(
      provider,
      sourceId,
      `${sourcePath}#${sourceId}`,
      {
        ...metadata,
        createdAt: parseTimestamp(conversation.create_time ?? conversation.created_at ?? conversation.createdAt),
        updatedAt: parseTimestamp(conversation.update_time ?? conversation.updated_at ?? conversation.updatedAt),
      },
      messages,
      stringValue(conversation.title, conversation.name),
    );
    if (built) result.push(built);
  }
  return result;
}

export async function importOfficialExport(provider: "chatgpt" | "claude", path: string): Promise<{ conversations: Conversation[]; warnings: string[] }> {
  const documents = await readExportJson(path);
  const json = documents.find((document) => /conversations?\.json$/i.test(document.name)) ?? documents[0];
  if (!json) throw new Error("export contains no JSON entries");
  const conversations = exportConversations(provider, json.value, path);
  return { conversations, warnings: documents.length > 1 ? [`read ${documents.length} JSON entries; selected ${json.name}`] : [] };
}

export const parseChatgptExport = (value: unknown, sourcePath = "chatgpt-export.json"): Conversation[] => exportConversations("chatgpt", value, sourcePath);
export const parseClaudeExport = (value: unknown, sourcePath = "claude-export.json"): Conversation[] => exportConversations("claude", value, sourcePath);
