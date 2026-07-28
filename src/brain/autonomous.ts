import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";

export type AutomationAuthority = "read" | "write" | "admin";
export type AgentRunStatus = "planned" | "executing" | "proposed" | "committed" | "rejected" | "failed";

export interface AutomationPolicy {
	authority: AutomationAuthority;
	dryRun: boolean;
	ownedPaths: string[];
	managedSections?: string[];
	maxCost?: number;
	maxDurationMs?: number;
	protectedPaths?: string[];
}

export interface AgentRunIntent {
	id: string;
	agent: string;
	operation: string;
	baseCommit: string;
	plannedPaths: string[];
	policy: AutomationPolicy;
	createdAt: string;
	status: AgentRunStatus;
}

export interface MutationProposal {
	runId: string;
	paths: string[];
	changes: Array<{ path: string; content: string; managedSection?: string }>;
	cost: number;
	createdAt: string;
}

export interface AgentRunReceipt extends AgentRunIntent {
	proposal?: MutationProposal;
	result?: { commit?: string; dryRun: boolean; completedAt: string };
	error?: string;
}

function normalizedPath(path: string): string {
	const value = relative(".", path).split(sep).join("/");
	if (!value || value.startsWith("../") || value === ".." || value.startsWith(".brain/") || value.includes("\0")) throw new Error("automation path is outside the owned repository");
	return value;
}

function canWrite(authority: AutomationAuthority): boolean {
	return authority === "write" || authority === "admin";
}

function includesPath(path: string, ownedPaths: string[]): boolean {
	return ownedPaths.some((owned) => path === owned || path.startsWith(owned.endsWith("/") ? owned : owned + "/"));
}

export class AgentRunStore {
	private readonly runs = new Map<string, AgentRunReceipt>();
	create(input: { agent: string; operation: string; baseCommit: string; policy: AutomationPolicy; now?: Date }): AgentRunIntent {
		if (!input.agent.trim() || !input.operation.trim() || !input.baseCommit.trim()) throw new Error("invalid agent run intent");
		if (!canWrite(input.policy.authority) && !input.policy.dryRun) throw new Error("write authority is required for autonomous mutations");
		if (!input.policy.ownedPaths.length || input.policy.ownedPaths.some((path) => !path.trim() || path.startsWith(".brain"))) throw new Error("automation owned paths are required and cannot include protected metadata");
		const intent: AgentRunIntent = { id: randomUUID(), agent: input.agent, operation: input.operation, baseCommit: input.baseCommit, plannedPaths: input.policy.ownedPaths.map(normalizedPath), policy: { ...input.policy, ownedPaths: input.policy.ownedPaths.map(normalizedPath), protectedPaths: input.policy.protectedPaths?.map(normalizedPath) }, createdAt: (input.now ?? new Date()).toISOString(), status: "planned" };
		this.runs.set(intent.id, { ...intent });
		return { ...intent, plannedPaths: [...intent.plannedPaths], policy: { ...intent.policy } };
	}

	begin(id: string): AgentRunIntent {
		const run = this.require(id);
		if (run.status !== "planned") throw new Error("agent run is not pending");
		run.status = "executing";
		return { ...run };
	}

	propose(proposal: MutationProposal): AgentRunReceipt {
		const run = this.require(proposal.runId);
		if (run.status !== "executing") throw new Error("agent run is not executing");
		if (!Number.isFinite(proposal.cost) || proposal.cost < 0 || run.policy.maxCost !== undefined && proposal.cost > run.policy.maxCost) throw new Error("agent run cost budget exceeded");
		for (const change of proposal.changes) {
			const path = normalizedPath(change.path);
			if (!includesPath(path, run.plannedPaths) || run.policy.protectedPaths?.some((protectedPath) => path === protectedPath || path.startsWith(protectedPath + "/"))) throw new Error("agent proposal escapes owned paths");
			if (run.policy.managedSections && change.managedSection !== undefined && !run.policy.managedSections.includes(change.managedSection)) throw new Error("agent proposal uses an unowned managed section");
		}
		run.proposal = { ...proposal, paths: proposal.changes.map((change) => normalizedPath(change.path)), changes: proposal.changes.map((change) => ({ ...change })) };
		run.status = "proposed";
		return this.receipt(run);
	}

	commit(id: string, currentHead: string, now = new Date()): AgentRunReceipt {
		const run = this.require(id);
		if (run.status !== "proposed" || !run.proposal) throw new Error("agent run has no proposal");
		if (currentHead !== run.baseCommit) throw new Error("agent run base commit is stale");
		run.status = "committed";
		run.result = { dryRun: run.policy.dryRun, completedAt: now.toISOString() };
		return this.receipt(run);
	}

	reject(id: string, error: string): AgentRunReceipt {
		const run = this.require(id);
		if (!error.trim()) throw new Error("agent run rejection requires a reason");
		run.status = "rejected";
		run.error = error.slice(0, 4_000);
		return this.receipt(run);
	}

	get(id: string): AgentRunReceipt {
		return this.receipt(this.require(id));
	}

	private require(id: string): AgentRunReceipt {
		const run = this.runs.get(id);
		if (!run) throw new Error("agent run was not found");
		return run;
	}

	private receipt(run: AgentRunReceipt): AgentRunReceipt {
		return { ...run, plannedPaths: [...run.plannedPaths], policy: { ...run.policy }, proposal: run.proposal ? { ...run.proposal, paths: [...run.proposal.paths], changes: run.proposal.changes.map((change) => ({ ...change })) } : undefined, result: run.result ? { ...run.result } : undefined };
	}
}
