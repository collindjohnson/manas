import { readFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type RemoteRebasePolicy = "never" | "report";
export const REMOTE_FAULT_POINTS = ["remote-fetch", "remote-CAS", "push"] as const;
export type RemoteFaultPoint = (typeof REMOTE_FAULT_POINTS)[number];
export type RemoteFaultInjector = (point: RemoteFaultPoint) => void | Promise<void>;

export interface RemoteState {
  remoteName: string;
  branch: string;
  url?: string;
  localHead?: string;
  remoteHead?: string;
  available: boolean;
  fastForwardable: boolean;
  fetchedAt: string;
  highWaterMark?: string;
  degradedReason?: string;
}

export interface RemoteMutationLease {
  remoteName: string;
  branch: string;
  expectedRemoteHead?: string;
  localHead: string;
  issuedAt: string;
}

export interface RemoteMutationResult {
  commit: string;
}

export interface PushResult {
  ok: boolean;
  commit: string;
  remoteName: string;
  branch: string;
  remoteHead?: string;
  reason?: "remote-unavailable" | "stale-remote-head" | "non-fast-forward" | "rebase-required" | "push-failed";
}

export interface RemoteReconciliation {
  state: RemoteState;
  diverged: boolean;
  behind: number;
  ahead: number;
  conflictPaths: string[];
  affectedDocumentIds: string[];
  requiresRebase: boolean;
}

export interface BrainRemotePolicy {
  fetch(): Promise<RemoteState>;
  prepareMutation(expectedRemoteHead?: string): Promise<RemoteMutationLease>;
  push(result: RemoteMutationResult): Promise<PushResult>;
  reconcile(): Promise<RemoteReconciliation>;
}

export interface GitRemotePolicyOptions {
  remoteName?: string;
  branch?: string;
  rebasePolicy?: RemoteRebasePolicy;
  protectedBranches?: string[];
  clock?: () => Date;
  faultInjector?: RemoteFaultInjector;
}

async function git(root: string, args: string[], trim = true): Promise<string> {
  const result = await execFile("git", ["-C", root, ...args], { maxBuffer: 1024 * 1024 });
  return trim ? result.stdout.trim() : result.stdout;
}

function isMissingRemoteBranch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("couldn't find remote ref");
}

function redactedRemoteUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "redacted";
      parsed.password = "redacted";
    }
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/u, "//redacted@");
  }
}

async function branchName(root: string, configured?: string): Promise<string> {
  if (configured) return configured;
  const branch = await git(root, ["branch", "--show-current"]);
  if (!branch) throw new Error("remote policy requires a named Git branch");
  return branch;
}

async function remoteHead(root: string, remoteName: string, branch: string): Promise<string | undefined> {
  const output = await git(root, ["ls-remote", remoteName, "refs/heads/" + branch]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean)[0]?.split(/\s+/u)[0];
}

async function isAncestor(root: string, ancestor: string | undefined, descendant: string | undefined): Promise<boolean> {
  if (!ancestor || !descendant) return !ancestor;
  try {
    await git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export class GitBrainRemotePolicy implements BrainRemotePolicy {
  private readonly remoteName: string;
  private readonly rebasePolicy: RemoteRebasePolicy;
  private readonly protectedBranches: Set<string>;
  private readonly clock: () => Date;
  private readonly faultInjector?: RemoteFaultInjector;
  private branchValue?: string;
  private activeLease?: RemoteMutationLease;
  private highWaterMark?: string;

  constructor(private readonly root: string, options: GitRemotePolicyOptions = {}) {
    this.remoteName = options.remoteName ?? "origin";
    this.rebasePolicy = options.rebasePolicy ?? "never";
    this.protectedBranches = new Set(options.protectedBranches ?? ["main", "master"]);
    this.clock = options.clock ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.branchValue = options.branch;
  }

  private async branch(): Promise<string> {
    this.branchValue ??= await branchName(this.root);
    return this.branchValue;
  }

  async fetch(): Promise<RemoteState> {
    const branch = await this.branch();
    const fetchedAt = this.clock().toISOString();
    let url: string;
    try {
      url = await git(this.root, ["remote", "get-url", this.remoteName]);
    } catch {
      return { remoteName: this.remoteName, branch, available: false, fastForwardable: false, fetchedAt, degradedReason: "remote is not configured" };
    }
    try {
      await this.faultInjector?.("remote-fetch");
      await git(this.root, ["fetch", "--prune", this.remoteName]);
    } catch (error) {
      if (!isMissingRemoteBranch(error)) {
        return {
          remoteName: this.remoteName,
          branch,
          url: redactedRemoteUrl(url),
          localHead: await git(this.root, ["rev-parse", "HEAD"]).catch(() => undefined),
          available: false,
          fastForwardable: false,
          fetchedAt,
          degradedReason: "remote fetch failed",
        };
      }
    }
    const localHead = await git(this.root, ["rev-parse", "HEAD"]).catch(() => undefined);
    const remote = await remoteHead(this.root, this.remoteName, branch).catch(() => undefined);
    const fastForwardable = await isAncestor(this.root, remote, localHead);
    this.highWaterMark = remote ?? this.highWaterMark;
    return { remoteName: this.remoteName, branch, url: redactedRemoteUrl(url), localHead, remoteHead: remote, available: true, fastForwardable, fetchedAt, highWaterMark: this.highWaterMark };
  }

  async prepareMutation(expectedRemoteHead?: string): Promise<RemoteMutationLease> {
    const state = await this.fetch();
    if (!state.available) throw new Error(state.degradedReason ?? "remote is unavailable");
    if (state.remoteHead !== expectedRemoteHead) throw new Error("stale remote head");
    const localHead = state.localHead;
    if (!localHead) throw new Error("remote mutation requires a local Git commit");
    const lease: RemoteMutationLease = { remoteName: state.remoteName, branch: state.branch, expectedRemoteHead, localHead, issuedAt: this.clock().toISOString() };
    this.activeLease = lease;
    return lease;
  }

  async push(result: RemoteMutationResult): Promise<PushResult> {
    const lease = this.activeLease;
    if (!lease) throw new Error("remote mutation lease is required");
    if (result.commit !== lease.localHead && !(await isAncestor(this.root, lease.localHead, result.commit))) throw new Error("remote mutation commit does not descend from lease");
    let currentRemoteHead: string | undefined;
    try {
      await this.faultInjector?.("remote-CAS");
      currentRemoteHead = await remoteHead(this.root, lease.remoteName, lease.branch);
    } catch {
      return { ok: false, commit: result.commit, remoteName: lease.remoteName, branch: lease.branch, reason: "remote-unavailable" };
    }
    if (currentRemoteHead !== lease.expectedRemoteHead) {
      return { ok: false, commit: result.commit, remoteName: lease.remoteName, branch: lease.branch, remoteHead: currentRemoteHead, reason: "stale-remote-head" };
    }
    if (currentRemoteHead && !(await isAncestor(this.root, currentRemoteHead, result.commit))) {
      return { ok: false, commit: result.commit, remoteName: lease.remoteName, branch: lease.branch, remoteHead: currentRemoteHead, reason: this.rebasePolicy === "report" || this.protectedBranches.has(lease.branch) ? "rebase-required" : "non-fast-forward" };
    }
    try {
      await this.faultInjector?.("push");
      const leaseValue = lease.expectedRemoteHead ?? "";
      await git(this.root, ["push", "--force-with-lease=refs/heads/" + lease.branch + ":" + leaseValue, lease.remoteName, result.commit + ":refs/heads/" + lease.branch]);
    } catch {
      return { ok: false, commit: result.commit, remoteName: lease.remoteName, branch: lease.branch, remoteHead: currentRemoteHead, reason: "push-failed" };
    }
    this.activeLease = undefined;
    this.highWaterMark = result.commit;
    return { ok: true, commit: result.commit, remoteName: lease.remoteName, branch: lease.branch, remoteHead: result.commit };
  }

  async reconcile(): Promise<RemoteReconciliation> {
    const state = await this.fetch();
    if (!state.available || !state.remoteHead || !state.localHead) return { state, diverged: false, behind: 0, ahead: 0, conflictPaths: [], affectedDocumentIds: [], requiresRebase: false };
    const counts = (await git(this.root, ["rev-list", "--left-right", "--count", state.remoteHead + "..." + state.localHead])).split(/\s+/u).map(Number);
    const behind = counts[0] ?? 0;
    const ahead = counts[1] ?? 0;
    const diverged = behind > 0 && ahead > 0;
    const diffRef = diverged ? state.remoteHead + "..." + state.localHead : state.remoteHead + ".." + state.localHead;
    const conflictPaths = (await git(this.root, ["diff", "--name-only", diffRef])).split("\n").filter(Boolean);
    const affectedDocumentIds = new Set<string>();
    try {
      const entries = (await readFile(this.root + "/.brain/manifest.jsonl", "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id?: string; path?: string });
      for (const entry of entries) if (entry.id && entry.path && (conflictPaths.includes(entry.path) || conflictPaths.includes(".brain/manifest.jsonl"))) affectedDocumentIds.add(entry.id);
    } catch {
      // The repository may not have initialized metadata yet.
    }
    return { state, diverged, behind, ahead, conflictPaths, affectedDocumentIds: [...affectedDocumentIds].sort(), requiresRebase: diverged || (behind > 0 && ahead === 0 && this.rebasePolicy === "report") };
  }
}
