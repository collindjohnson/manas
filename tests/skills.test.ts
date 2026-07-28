import { describe, expect, test } from "bun:test";

const modulePath = ["..", "src", "skills"].join(String.fromCharCode(47));
const { createPinnedSkillRegistry, PINNED_SKILL_INVENTORY, SkillRegistry } = await import(modulePath);
const integrationsModule = await import("../src/skills-integrations");
const { openPgliteBrainStore } = await import("../src/brain/store");
const { listSkillFeedback, recordSkillFeedback } = await import("../src/brain/skill-feedback");

const skill = { id: "brain-search", version: "1.0.0", purpose: "Search the local brain", inputs: ["query"], outputs: ["citations"], operations: ["search"], authority: "read" as const, agents: ["codex", "mcp"] as const };

describe("skills and agent integrations", () => {
	test("resolves compatible skills and emits editable proposal scaffolds", () => {
		const registry = new SkillRegistry();
		registry.register(skill);
		expect(registry.resolve("brain-search", "codex")).toMatchObject({ id: "brain-search", version: "1.0.0" });
		expect(registry.scaffold("brain-search", "mcp")).toContain("status: proposal");
		expect(registry.propose(skill, "Add citation verification")).toMatchObject({ status: "proposal", requiresApproval: true });
	});

	test("rejects unsupported agents and duplicate versions", () => {
		const registry = new SkillRegistry();
		registry.register(skill);
		expect(() => registry.register(skill)).toThrow("already registered");
		expect(() => registry.resolve("brain-search", "cursor")).toThrow("not registered");
	});

	test("loads the pinned inventory and gates context push on confidence", () => {
		const registry = createPinnedSkillRegistry();
		expect(PINNED_SKILL_INVENTORY.length).toBe(5);
		expect(registry.installProposal("brain-search", "codex")).toMatchObject({ status: "proposal", requiresApproval: true });
		expect(registry.pushContext({ agent: "codex", query: "q", citations: [], confidence: 1 })).toMatchObject({ status: "withheld", reason: "no citations" });
		expect(registry.pushContext({ agent: "codex", query: "q", citations: ["doc:chunk"], confidence: 0.9 })).toMatchObject({ status: "pushed" });
		expect(registry.recordFeedback({ skillId: "brain-search", agent: "codex", outcome: "used" }).recordedAt).toBeString();
		expect(registry.optimizerProposal({ skillId: "brain-search", version: "1.0.0", evidence: "replay", expectedImprovement: "raise recall" })).toMatchObject({ requiresApproval: true });
	});

	test("validates and proposes installation for every pinned skill across every supported agent", () => {
		const registry = createPinnedSkillRegistry();
		const integrations = integrationsModule.createAgentIntegrationRegistry();
		integrationsModule.validatePinnedIntegrations(PINNED_SKILL_INVENTORY, integrations);
		expect(integrations.size).toBe(6);
		for (const skill of PINNED_SKILL_INVENTORY) for (const agent of skill.agents) expect(integrationsModule.proposeSkillInstallation(registry, integrations, skill.id, agent, skill.version).proposal.requiresApproval).toBe(true);
		expect(() => integrationsModule.proposeSkillInstallation(registry, integrations, "brain-search", "hermes")).not.toThrow();
	});

	test("persists feedback with tenant and brain scope and idempotent delivery", async () => {
		const store = await openPgliteBrainStore();
		try {
			const first = await recordSkillFeedback(store, { id: "feedback-1", tenantId: "tenant-a", brainId: "brain-a", skillId: "brain-search", version: "1.0.0", agent: "codex", outcome: "used", confidence: 0.9, recordedAt: new Date("2026-07-27T00:00:00.000Z") });
			expect(first).toMatchObject({ id: "feedback-1", tenantId: "tenant-a", brainId: "brain-a", skillId: "brain-search", confidence: 0.9 });
			expect(await recordSkillFeedback(store, { id: "feedback-1", tenantId: "tenant-a", brainId: "brain-a", skillId: "brain-search", version: "1.0.0", agent: "codex", outcome: "used" })).toEqual(first);
			expect(await listSkillFeedback(store, { tenantId: "tenant-a", brainId: "brain-a" })).toEqual([first]);
			expect(await listSkillFeedback(store, { tenantId: "tenant-b", brainId: "brain-a" })).toEqual([]);
		} finally { await store.close(); }
	});
});
