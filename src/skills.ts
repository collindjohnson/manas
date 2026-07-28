export type SkillAuthority = "read" | "write" | "admin";
export type SkillAgent = "claude-code" | "codex" | "cursor" | "openclaw" | "hermes" | "mcp";

export interface SkillDefinition {
	id: string;
	version: string;
	purpose: string;
	inputs: string[];
	outputs: string[];
	operations: string[];
	authority: SkillAuthority;
	agents: SkillAgent[];
	compatibility?: { minimumEngine: string; maximumEngine?: string };
}

export interface SkillProposal {
	skillId: string;
	version: string;
	changes: string;
	status: "proposal";
	requiresApproval: true;
}

export interface PinnedSkill extends SkillDefinition { source: "gbrain-v0.42.65.0"; acceptanceTest: string; }

export const PINNED_SKILL_INVENTORY: PinnedSkill[] = [
	{ id: "brain-search", version: "1.0.0", purpose: "Search the authorized local brain with verified citations", inputs: ["query"], outputs: ["results", "citations"], operations: ["search", "citation.resolve"], authority: "read", agents: ["claude-code", "codex", "cursor", "openclaw", "hermes", "mcp"], source: "gbrain-v0.42.65.0", acceptanceTest: "tests/skills.test.ts" },
	{ id: "brain-capture", version: "1.0.0", purpose: "Capture a user-approved note into the brain inbox", inputs: ["content", "consent"], outputs: ["page", "receipt"], operations: ["capture"], authority: "write", agents: ["claude-code", "codex", "cursor", "openclaw", "hermes", "mcp"], source: "gbrain-v0.42.65.0", acceptanceTest: "tests/capture.test.ts" },
	{ id: "brain-grounded-think", version: "1.0.0", purpose: "Answer from verified evidence or report a knowledge gap", inputs: ["question"], outputs: ["answer", "citations", "knowledgeGaps"], operations: ["think", "citation.resolve"], authority: "read", agents: ["claude-code", "codex", "cursor", "openclaw", "hermes", "mcp"], source: "gbrain-v0.42.65.0", acceptanceTest: "tests/reasoning.test.ts" },
	{ id: "brain-source-sync", version: "1.0.0", purpose: "Synchronize an authorized source while preserving managed notes", inputs: ["source", "checkpoint"], outputs: ["changes", "checkpoint"], operations: ["sources_sync", "projection"], authority: "write", agents: ["claude-code", "codex", "cursor", "openclaw", "hermes", "mcp"], source: "gbrain-v0.42.65.0", acceptanceTest: "tests/source-sync.test.ts" },
	{ id: "brain-maintenance", version: "1.0.0", purpose: "Propose bounded maintenance actions for review", inputs: ["scope", "dryRun"], outputs: ["proposal", "audit"], operations: ["jobs", "repair"], authority: "admin", agents: ["codex", "hermes", "mcp"], source: "gbrain-v0.42.65.0", acceptanceTest: "tests/autonomous.test.ts" },
];

export interface SkillContextPush { status: "pushed" | "withheld"; agent: SkillAgent; query: string; citations: string[]; confidence: number; reason?: string; }
export interface SkillFeedback { skillId: string; agent: SkillAgent; outcome: "used" | "volunteered" | "rejected"; confidence?: number; recordedAt: string; }

function validSkill(skill: SkillDefinition): void {
	if (!skill.id.trim() || !skill.version.trim() || !skill.purpose.trim() || !skill.inputs.length || !skill.outputs.length || !skill.operations.length || !skill.agents.length) throw new Error("invalid skill definition");
	if (new Set(skill.agents).size !== skill.agents.length) throw new Error("skill agents must be unique");
}

export class SkillRegistry {
	private readonly skills = new Map<string, SkillDefinition>();
	register(skill: SkillDefinition): void {
		validSkill(skill);
		const key = skill.id + "@" + skill.version;
		if (this.skills.has(key)) throw new Error("skill version is already registered");
		this.skills.set(key, { ...skill, inputs: [...skill.inputs], outputs: [...skill.outputs], operations: [...skill.operations], agents: [...skill.agents] });
	}
	list(): SkillDefinition[] { return [...this.skills.values()].sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version)); }
	resolve(id: string, agent: SkillAgent, version?: string): SkillDefinition {
		const matches = this.list().filter((skill) => skill.id === id && (version === undefined || skill.version === version) && skill.agents.includes(agent));
		if (matches.length !== 1) throw new Error(matches.length ? "skill version is ambiguous" : "compatible skill is not registered");
		return { ...matches[0]!, inputs: [...matches[0]!.inputs], outputs: [...matches[0]!.outputs], operations: [...matches[0]!.operations], agents: [...matches[0]!.agents] };
	}
	scaffold(id: string, agent: SkillAgent, version?: string): string {
		const skill = this.resolve(id, agent, version);
		return ["---", "name: " + skill.id, "version: " + skill.version, "authority: " + skill.authority, "status: proposal", "---", "", "# " + skill.purpose, "", "Inputs: " + skill.inputs.join(", "), "Outputs: " + skill.outputs.join(", "), ""].join("\n");
	}
	propose(skill: SkillDefinition, changes: string): SkillProposal {
		validSkill(skill);
		if (!changes.trim()) throw new Error("skill proposal cannot be empty");
		return { skillId: skill.id, version: skill.version, changes, status: "proposal", requiresApproval: true };
	}
	installProposal(id: string, agent: SkillAgent, version?: string): SkillProposal {
		const skill = this.resolve(id, agent, version);
		return this.propose(skill, `Install the ${agent} adapter for ${skill.id}@${skill.version}`);
	}
	pushContext(input: { agent: SkillAgent; query: string; citations: string[]; confidence: number; minimumConfidence?: number }): SkillContextPush {
		const minimum = input.minimumConfidence ?? 0.7;
		if (!input.query.trim() || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 || !Number.isFinite(minimum) || minimum < 0 || minimum > 1) throw new Error("invalid skill context");
		const citations = [...new Set(input.citations.filter((citation) => citation.trim()))];
		if (!citations.length || input.confidence < minimum) return { status: "withheld", agent: input.agent, query: input.query.trim(), citations, confidence: input.confidence, reason: !citations.length ? "no citations" : "confidence below threshold" };
		return { status: "pushed", agent: input.agent, query: input.query.trim(), citations, confidence: input.confidence };
	}
	recordFeedback(input: Omit<SkillFeedback, "recordedAt"> & { recordedAt?: Date }): SkillFeedback {
		if (!input.skillId.trim() || !["claude-code", "codex", "cursor", "openclaw", "hermes", "mcp"].includes(input.agent) || !["used", "volunteered", "rejected"].includes(input.outcome) || input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) throw new Error("invalid skill feedback");
		return { ...input, recordedAt: (input.recordedAt ?? new Date()).toISOString() };
	}
	optimizerProposal(input: { skillId: string; version: string; evidence: string; expectedImprovement: string }): SkillProposal {
		if (!input.skillId.trim() || !input.version.trim() || !input.evidence.trim() || !input.expectedImprovement.trim()) throw new Error("invalid optimizer proposal");
		return { skillId: input.skillId, version: input.version, changes: `${input.expectedImprovement}\nEvidence: ${input.evidence}`, status: "proposal", requiresApproval: true };
	}
}

export function createPinnedSkillRegistry(): SkillRegistry {
	const registry = new SkillRegistry();
	for (const skill of PINNED_SKILL_INVENTORY) registry.register(skill);
	return registry;
}
