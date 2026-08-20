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

const repositoryMetadataCache = new Map<string, Pick<SessionMeta, "repository" | "repositoryUrl">>();

function boundedGit(repository: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
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
  const cached = repositoryMetadataCache.get(metadata.repository);
  if (cached) return { ...metadata, ...cached };
  const repositoryUrl = boundedGit(metadata.repository, ["config", "--get", "remote.origin.url"]);
  const repository = boundedGit(metadata.repository, ["rev-parse", "--show-toplevel"]) ?? metadata.repository;
  const resolved = { repository, ...(repositoryUrl ? { repositoryUrl } : {}) };
  repositoryMetadataCache.set(metadata.repository, resolved);
  return { ...metadata, ...resolved };
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
import { execFileSync } from "node:child_process";
