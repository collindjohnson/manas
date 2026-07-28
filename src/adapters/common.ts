import type { Conversation, MessageRole, Provider, TranscriptMessage } from "../model";
import {
  extractText,
  firstDefined,
  isSubstantiveMessage,
  normalizeMessages,
  parseTimestamp,
  projectFromPath,
  sha256,
  stringValue,
  transcriptBody,
} from "../utils";

export interface SessionMeta {
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  repository?: string;
  repositoryUrl?: string;
  repoKey?: string;
  project?: string;
  workspacePath?: string;
}

export function recordText(value: unknown): string {
  return extractText(value);
}

export function roleFrom(value: unknown): MessageRole | undefined {
  if (typeof value !== "string") return undefined;
  const role = value.toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "ai" || role === "model") return "assistant";
  return undefined;
}

export function sortMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      if (!left.message.timestamp || !right.message.timestamp) return left.index - right.index;
      return left.message.timestamp.localeCompare(right.message.timestamp) || left.index - right.index;
    })
    .map(({ message }) => message);
}

export function metadataFromCwd(cwd: unknown): SessionMeta {
  const metadata = projectFromPath(typeof cwd === "string" ? cwd : undefined);
  if (!metadata.repository) return metadata;
  const remote = Bun.spawnSync(["git", "-C", metadata.repository, "config", "--get", "remote.origin.url"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const repositoryUrl = remote.exitCode === 0 ? new TextDecoder().decode(remote.stdout).trim() : undefined;
  const root = Bun.spawnSync(["git", "-C", metadata.repository, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const repository = root.exitCode === 0 ? new TextDecoder().decode(root.stdout).trim() : metadata.repository;
  return { ...metadata, repository, repositoryUrl };
}

export function buildConversation(
  provider: Provider,
  sourceId: string,
  sourcePath: string,
  meta: SessionMeta,
  messages: TranscriptMessage[],
  explicitTitle?: unknown,
): Conversation | undefined {
  const normalized = normalizeMessages(sortMessages(messages));
  if (!normalized.messages.some(isSubstantiveMessage)) return undefined;
  const firstUser = normalized.messages.find((message) => message.role === "user");
  const title = stringValue(explicitTitle) ?? firstUser?.text.split("\n")[0].slice(0, 140) ?? "Untitled conversation";
  const messageTimes = normalized.messages.map((message) => message.timestamp).filter(Boolean) as string[];
  const createdAt = firstDefined(parseTimestamp(meta.createdAt), messageTimes[0]);
  const updatedAt = firstDefined(parseTimestamp(meta.updatedAt), messageTimes.at(-1), createdAt);
  const body = transcriptBody(normalized.messages);
  return {
    provider,
    sourceId,
    sourcePath,
    title,
    createdAt,
    updatedAt,
    workspacePath: meta.workspacePath,
    project: meta.project,
    repository: meta.repository,
    repositoryUrl: meta.repositoryUrl,
    repoKey: meta.repoKey,
    messages: normalized.messages,
    redactions: normalized.redactions,
    fingerprint: sha256(`${provider}\0${sourceId}\0${body}`),
  };
}

export function mergeMeta(...values: SessionMeta[]): SessionMeta {
  const result: SessionMeta = {};
  for (const value of values) {
    for (const key of Object.keys(value) as Array<keyof SessionMeta>) {
      if (value[key] !== undefined && result[key] === undefined) result[key] = value[key];
    }
  }
  return result;
}
