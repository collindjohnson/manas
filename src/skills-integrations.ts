import type { PinnedSkill, SkillAgent, SkillContextPush, SkillDefinition, SkillProposal, SkillRegistry } from "./skills";

export interface AgentIntegration { agent: SkillAgent; home: string; protocol: "file" | "mcp"; installPath(skill: SkillDefinition): string; validate(skill: PinnedSkill): void; }
export interface SkillInstallationProposal { agent: SkillAgent; skillId: string; version: string; path: string; proposal: SkillProposal; }

const homes: Record<SkillAgent, { home: string; protocol: "file" | "mcp" }> = { "claude-code": { home: ".claude/skills", protocol: "file" }, codex: { home: ".codex/skills", protocol: "file" }, cursor: { home: ".cursor/skills", protocol: "file" }, openclaw: { home: ".openclaw/skills", protocol: "file" }, hermes: { home: ".hermes/skills", protocol: "file" }, mcp: { home: "mcp://skills", protocol: "mcp" } };

function safePart(value: string): string { if (!value.trim() || value.includes("/") || value.includes("\\") || value.includes("..")) throw new Error("invalid skill path component"); return value; }

export function createAgentIntegrationRegistry(): Map<SkillAgent, AgentIntegration> {
	return new Map((Object.entries(homes) as Array<[SkillAgent, { home: string; protocol: "file" | "mcp" }]>).map(([agent, details]) => [agent, { agent, ...details, installPath: (skill: SkillDefinition) => `${details.home}/${safePart(skill.id)}@${safePart(skill.version)}.md`, validate: (skill: PinnedSkill) => { if (!skill.agents.includes(agent)) throw new Error(`skill ${skill.id} is not compatible with ${agent}`); } }]));
}

export function proposeSkillInstallation(registry: SkillRegistry, integrations: Map<SkillAgent, AgentIntegration>, skillId: string, agent: SkillAgent, version?: string): SkillInstallationProposal {
	const integration = integrations.get(agent); if (!integration) throw new Error("agent integration is not registered"); const skill = registry.resolve(skillId, agent, version); const proposal = registry.propose(skill, `Install ${skill.id}@${skill.version} at ${integration.installPath(skill)} for ${agent}`); return { agent, skillId: skill.id, version: skill.version, path: integration.installPath(skill), proposal };
}

export function validatePinnedIntegrations(inventory: readonly PinnedSkill[], integrations = createAgentIntegrationRegistry()): void {
	if (integrations.size !== Object.keys(homes).length) throw new Error("agent integration inventory is incomplete");
	for (const skill of inventory) for (const agent of skill.agents) integrations.get(agent)?.validate(skill);
}

export function pushSkillContext(registry: SkillRegistry, input: { agent: SkillAgent; query: string; citations: string[]; confidence: number; minimumConfidence?: number }): SkillContextPush { return registry.pushContext(input); }
