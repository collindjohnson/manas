import { describe, expect, test } from "bun:test";
import {
  normalizeMessages,
  redactSecrets,
  sanitizeTitle,
  stripSyntheticPrompt,
  transcriptBody,
  uuidv5,
} from "../src/utils";

describe("utility normalization", () => {
  test("generates deterministic UUIDv5 IDs", () => {
    expect(uuidv5("chatgpt:conversation-1")).toBe(uuidv5("chatgpt:conversation-1"));
    expect(uuidv5("chatgpt:conversation-1")).not.toBe(uuidv5("chatgpt:conversation-2"));
    expect(uuidv5("chatgpt:conversation-1")).toBe("0B328D5C-C824-54BE-B594-C5F216B02E3E");
  });

  test("removes synthetic prompt blocks but preserves the request", () => {
    const result = stripSyntheticPrompt(
      "<environment_context>secret harness data</environment_context>\n\nPlease make the button blue.",
    );
    expect(result).toBe("Please make the button blue.");
  });

  test("removes injected Codex AGENTS instructions", () => {
    expect(stripSyntheticPrompt("# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>hidden</INSTRUCTIONS>\n\nActual request")).toBe("Actual request");
  });

  test("keeps slash-command arguments while removing command wrapper metadata", () => {
    expect(stripSyntheticPrompt("<command-message>boris</command-message>\n<command-name>/boris</command-name>\n<command-args>make it work</command-args>")).toBe("make it work");
  });

  test("redacts high-confidence credentials", () => {
    const result = redactSecrets("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456 and Bearer abcdefghijklmnopqrstuvwxyz123456 and sk-ant-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.count).toBe(3);
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  test("sanitizes titles for archive filenames", () => {
    expect(sanitizeTitle("../A: title? *with* secrets")).toBe("A- title- -with- secrets");
  });

  test("normalizes messages and preserves user/assistant body format", () => {
    const { messages, redactions } = normalizeMessages([
      { role: "user", text: "<system-reminder>ignore</system-reminder>Hi" },
      { role: "assistant", text: "Hello" },
      { role: "assistant", text: "Hello" },
    ]);
    expect(redactions).toBe(0);
    expect(messages).toHaveLength(2);
    expect(transcriptBody(messages)).toBe("user: Hi\n\nassistant: Hello\n");
  });
});
