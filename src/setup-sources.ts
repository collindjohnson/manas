export type SetupSourceKind = "local" | "export";

export interface SetupSourceDescriptor {
	id: "claude_code" | "codex" | "pi" | "cursor" | "grok" | "chatgpt" | "claude";
	kind: SetupSourceKind;
	detectable: boolean;
	instructions: string;
}

export const SETUP_SOURCE_REGISTRY: readonly SetupSourceDescriptor[] = [
	{ id: "claude_code", kind: "local", detectable: true, instructions: "Manas can detect local Claude Code conversation history." },
	{ id: "codex", kind: "local", detectable: true, instructions: "Manas can detect local Codex conversation history." },
	{ id: "pi", kind: "local", detectable: true, instructions: "Manas can detect local Pi conversation history." },
	{ id: "cursor", kind: "local", detectable: true, instructions: "Manas can detect local Cursor conversation history." },
	{ id: "grok", kind: "local", detectable: true, instructions: "Manas can detect local Grok conversation history." },
	{ id: "chatgpt", kind: "export", detectable: false, instructions: "Export your ChatGPT data, then run manas import chatgpt with the exported ZIP or JSON file." },
	{ id: "claude", kind: "export", detectable: false, instructions: "Export your Claude data, then run manas import claude with the exported ZIP or JSON file." },
];

export function setupSourceRegistry(): SetupSourceDescriptor[] {
	return SETUP_SOURCE_REGISTRY.map((source) => ({ ...source }));
}
