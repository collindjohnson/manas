import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { MessageRole, Provider, TranscriptMessage } from "./model";

const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function uuidv5(name: string, namespace = UUID_NAMESPACE_URL): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(name, "utf8"))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function firstDefined<T>(...values: Array<T | null | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined && value !== null);
}

export function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

const SYNTHETIC_BLOCKS = [
  "local-command-caveat",
  "environment_context",
  "permissions instructions",
  "collaboration_mode",
  "skills_instructions",
  "project_context",
  "system-reminder",
  "custom_message",
  "plan-mode-context",
];

export function stripSyntheticPrompt(input: string): string {
  let text = input.replace(/\r\n/g, "\n");
  for (const block of SYNTHETIC_BLOCKS) {
    const escaped = block.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
  }
  text = text.replace(/^# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>\s*/i, "");
  text = text.replace(/<(?:command-message|command-name)(?:\s[^>]*)?>[\s\S]*?<\/(?:command-message|command-name)>/gi, "");
  text = text.replace(/<\/?command-args(?:\s[^>]*)?>/gi, "");
  text = text.replace(/<[^>]+>\s*<\/[^>]+>/g, "");
  text = text.replace(/\[PLAN MODE ACTIVE\][\s\S]*?(?=\n\n|$)/gi, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => extractTextPart(part))
      .filter(Boolean)
      .join("\n\n");
  }
  return extractTextPart(content);
}

function extractTextPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (["thinking", "tool_use", "tool_result", "toolCall", "toolResult", "tool_call", "tool_calls", "execution_output", "computer_call"].includes(type)) {
    return "";
  }
  if (type === "text" || type === "output_text" || type === "input_text") {
    return typeof record.text === "string" ? record.text : "";
  }
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.parts)) return extractText(record.parts);
  if (Array.isArray(record.content)) return extractText(record.content);
  return "";
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { pattern: /\b(?:sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,})\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_TOKEN]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: "[REDACTED_JWT]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=?/gi, replacement: "Bearer [REDACTED_TOKEN]" },
  {
    pattern: /((?:export\s+)?[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*["']?)(?!\[REDACTED_)([^\s"'`]{12,})/g,
    replacement: "$1[REDACTED_SECRET]",
  },
];

export function redactSecrets(input: string): { text: string; count: number } {
  let text = input;
  let count = 0;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      count += 1;
      if (replacement.includes("$1")) return `${args[1]}[REDACTED_SECRET]`;
      return replacement;
    });
  }
  return { text, count };
}

export function sanitizeTitle(input: string | undefined): string {
  const value = (input ?? "Untitled conversation")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^[.-]+|[.-]+$/g, "");
  return (value || "Untitled conversation").slice(0, 140);
}

export function archiveProvider(provider: Provider): string {
  return provider === "claude_code" ? "claude" : provider;
}

const PROVIDER_NAMES: Record<Provider, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  cursor: "Cursor",
  grok: "Grok Build CLI",
  chatgpt: "ChatGPT",
  claude: "Claude",
};

export function providerName(provider: Provider): string {
  return PROVIDER_NAMES[provider];
}

export function isSubstantiveMessage(message: TranscriptMessage): boolean {
  return message.role === "user" && stripSyntheticPrompt(message.text).length > 0;
}

export function normalizeMessages(messages: TranscriptMessage[]): { messages: TranscriptMessage[]; redactions: number } {
  let redactions = 0;
  const normalized: TranscriptMessage[] = [];
  for (const message of messages) {
    const text = stripSyntheticPrompt(message.text);
    if (!text) continue;
    const redacted = redactSecrets(text);
    redactions += redacted.count;
    const previous = normalized.at(-1);
    if (previous && previous.role === message.role && previous.text === redacted.text) continue;
    normalized.push({ role: message.role, text: redacted.text, timestamp: message.timestamp });
  }
  return { messages: normalized, redactions };
}

export function transcriptBody(messages: TranscriptMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.text}`).join("\n\n").trim() + "\n";
}

export function safeRelativePath(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(root, candidate);
  const relative = absoluteCandidate.slice(absoluteRoot.length).replace(/^[/\\]/, "");
  if (absoluteCandidate !== absoluteRoot && !absoluteCandidate.startsWith(`${absoluteRoot}/`)) {
    throw new Error(`path escapes root: ${candidate}`);
  }
  return relative;
}

export function projectFromPath(path: string | undefined): { workspacePath?: string; project?: string; repository?: string; repoKey?: string } {
  if (!path || !path.startsWith("/")) return {};
  const workspacePath = resolve(path);
  const project = basename(workspacePath) || undefined;
  return { workspacePath, project, repository: workspacePath, repoKey: project };
}

export function sourcePathToSessionId(sourcePath: string): string {
  return basename(sourcePath).replace(/\.jsonl$/i, "");
}

export function directoryForFile(path: string): string {
  return dirname(path);
}

export function joinNonEmpty(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join("/");
}
