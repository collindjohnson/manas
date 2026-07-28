import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { GitBrainRemotePolicy, REMOTE_FAULT_POINTS } from "../src/brain/remote";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<string> {
  return (await execFile("git", ["-C", root, ...args])).stdout.trim();
}

async function repository(root: string): Promise<BrainRepository> {
  const brain = new BrainRepository(join(root, "brain"));
  await brain.initialize();
  await git(brain.root, ["config", "user.name", "Test User"]);
  await git(brain.root, ["config", "user.email", "test@example.invalid"]);
  return brain;
}

async function fixture(): Promise<{ root: string; remote: string; brain: BrainRepository; policy: GitBrainRemotePolicy }> {
  const root = await mkdtemp(join(tmpdir(), "chat-history-remote-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  await execFile("git", ["init", "--bare", remote]);
  const brain = await repository(root);
  await git(brain.root, ["remote", "add", "origin", remote]);
  return { root, remote, brain, policy: new GitBrainRemotePolicy(brain.root, { branch: "master" }) };
}

describe("explicit Git remote coordination", () => {
  test("fetches without merging and pushes through a remote-head lease", async () => {
    const { root, remote, brain, policy } = await fixture();
    const first = await brain.putPage("notes/first.md", "first");
    const initial = await policy.fetch();
    expect(initial.available).toBe(true);
    expect(initial.remoteHead).toBeUndefined();
    const lease = await policy.prepareMutation(undefined);
    expect(lease.localHead).toBe(first.commit);
    await expect(policy.push({ commit: first.commit })).resolves.toMatchObject({ ok: true, remoteHead: first.commit });

    const cloneRoot = join(root, "clone");
    await execFile("git", ["clone", remote, cloneRoot]);
    await git(cloneRoot, ["config", "user.name", "Clone User"]);
    await git(cloneRoot, ["config", "user.email", "clone@example.invalid"]);
    const clone = new BrainRepository(cloneRoot);
    const second = await clone.putPage("notes/second.md", "second", undefined, undefined, first.commit);
    const clonePolicy = new GitBrainRemotePolicy(cloneRoot, { branch: "master" });
    await clonePolicy.prepareMutation(first.commit);
    await expect(clonePolicy.push({ commit: second.commit })).resolves.toMatchObject({ ok: true, remoteHead: second.commit });

    const fetched = await policy.fetch();
    expect(fetched.remoteHead).toBe(second.commit);
    expect(await brain.head()).toBe(first.commit);
    expect(await brain.getPage("notes/second.md")).toBeUndefined();
  });

  test("reports stale protected-branch state while preserving the local commit", async () => {
    const { root, remote, brain, policy } = await fixture();
    const first = await brain.putPage("notes/first.md", "first");
    await policy.prepareMutation(undefined);
    await policy.push({ commit: first.commit });

    const cloneRoot = join(root, "clone");
    await execFile("git", ["clone", remote, cloneRoot]);
    await git(cloneRoot, ["config", "user.name", "Clone User"]);
    await git(cloneRoot, ["config", "user.email", "clone@example.invalid"]);
    const clone = new BrainRepository(cloneRoot);
    const second = await clone.putPage("notes/remote.md", "remote", undefined, undefined, first.commit);
    const clonePolicy = new GitBrainRemotePolicy(cloneRoot, { branch: "master" });
    await clonePolicy.prepareMutation(first.commit);
    await clonePolicy.push({ commit: second.commit });

    const local = await brain.putPage("notes/local.md", "local", undefined, undefined, first.commit);
    await expect(policy.prepareMutation(first.commit)).rejects.toThrow("stale remote head");
    const reconciliation = await policy.reconcile();
    expect(reconciliation.diverged).toBe(true);
    expect(reconciliation.requiresRebase).toBe(true);
    expect(reconciliation.conflictPaths).toContain(".brain/manifest.jsonl");
    expect(await brain.head()).toBe(local.commit);
  });

  test("allows exactly one winner when two clones race the same remote head", async () => {
    const { root, remote, brain, policy } = await fixture();
    const first = await brain.putPage("notes/first.md", "first");
    await policy.prepareMutation(undefined);
    await policy.push({ commit: first.commit });

    const cloneA = join(root, "clone-a");
    const cloneB = join(root, "clone-b");
    await Promise.all([execFile("git", ["clone", remote, cloneA]), execFile("git", ["clone", remote, cloneB])]);
    for (const cloneRoot of [cloneA, cloneB]) {
      await git(cloneRoot, ["config", "user.name", "Race User"]);
      await git(cloneRoot, ["config", "user.email", "race@example.invalid"]);
    }
    const a = new BrainRepository(cloneA);
    const b = new BrainRepository(cloneB);
    const [commitA, commitB] = await Promise.all([
      a.putPage("notes/a.md", "a", undefined, undefined, first.commit),
      b.putPage("notes/b.md", "b", undefined, undefined, first.commit),
    ]);
    const policyA = new GitBrainRemotePolicy(cloneA, { branch: "master" });
    const policyB = new GitBrainRemotePolicy(cloneB, { branch: "master" });
    await Promise.all([policyA.prepareMutation(first.commit), policyB.prepareMutation(first.commit)]);
    const results = await Promise.all([policyA.push({ commit: commitA.commit }), policyB.push({ commit: commitB.commit })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
  });

	test("degrades on remote outage without losing local commits", async () => {
    const { brain, policy } = await fixture();
    await git(brain.root, ["remote", "set-url", "origin", join(brain.root, "does-not-exist.git")]);
    const state = await policy.fetch();
    expect(state.available).toBe(false);
    const local = await brain.putPage("notes/offline.md", "local");
    expect(await brain.head()).toBe(local.commit);
		expect(await brain.verify()).toMatchObject({ commit: local.commit, valid: true, issues: [] });
	});

	test("recovers deterministically at each remote coordination fault boundary", async () => {
		for (const point of REMOTE_FAULT_POINTS) {
			const { brain, policy } = await fixture();
			const first = await brain.putPage("notes/first.md", "first");
			if (point === "remote-fetch") {
				const faulted = new GitBrainRemotePolicy(brain.root, { branch: "master", faultInjector: (candidate) => { if (candidate === point) throw new Error(`injected ${candidate}`); } });
				expect((await faulted.fetch()).available).toBe(false);
				expect(await brain.head()).toBe(first.commit);
				continue;
			}
			await policy.prepareMutation(undefined);
			await policy.push({ commit: first.commit });
			const second = await brain.putPage("notes/second.md", "second", undefined, undefined, first.commit);
			const faulted = new GitBrainRemotePolicy(brain.root, { branch: "master", faultInjector: (candidate) => { if (candidate === point) throw new Error(`injected ${candidate}`); } });
			await faulted.prepareMutation(first.commit);
			expect(await faulted.push({ commit: second.commit })).toMatchObject({ ok: false, reason: point === "remote-CAS" ? "remote-unavailable" : "push-failed" });
			expect(await brain.verify()).toMatchObject({ commit: second.commit, valid: true, issues: [] });
		}
	});
});
