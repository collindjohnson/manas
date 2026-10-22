import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { readManagedFile, writeManagedFile, type ManagedAgent } from "./agent-management";
export interface VerificationInstallation { agent: ManagedAgent; home: string; stateRoot: string; configPath: string; }
export interface AgentVerification {
 version: 1; agent: ManagedAgent; definitionHash: string; checkedAt: string; sessionHash: string;
 nativeVersion: string; trustMode: "normal-client-policy";
 checks: { contextDelivered: true; exactCitation: true; noToolCalls: true };
}
export const verificationHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const verificationInstallationId = (options: Pick<VerificationInstallation, "agent" | "home">) => verificationHash(options.agent + ":" + resolve(options.home));
const location = (options: VerificationInstallation) => join(options.stateRoot, "agent-integrations", verificationInstallationId(options) + "-verification.json");
export async function agentDefinitionHash(options: VerificationInstallation): Promise<string | undefined> {
 const raw = await readManagedFile(join(options.stateRoot, "agent-integrations", verificationInstallationId(options) + "-hooks.json"));
 if (!raw) return;
 const receipt = JSON.parse(raw);
 if (receipt.agent !== options.agent || receipt.home !== resolve(options.home) || !receipt.group || !Array.isArray(receipt.events) || !receipt.events.length) return;
 const target = join(resolve(options.home), options.agent === "codex" ? ".codex/hooks.json" : ".claude/settings.json");
 const configuration = JSON.parse(await readManagedFile(target) ?? "{}");
 if (!receipt.events.every((event: string) => Array.isArray(configuration.hooks?.[event]) && configuration.hooks[event].some((group: unknown) => JSON.stringify(group) === JSON.stringify(receipt.group)))) return;
 let stat;
 try { stat = await lstat(options.configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
 if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw new Error("Agent verification requires a bounded regular configuration file.");
 const config = await readManagedFile(options.configPath);
 if (!config) return;
 return verificationHash(JSON.stringify({ receipt, configPath: resolve(options.configPath), configHash: verificationHash(config) }));
}
export async function readAgentVerification(options: VerificationInstallation): Promise<AgentVerification | undefined> {
 const raw = await readManagedFile(location(options));
 if (!raw) return;
 let receipt: AgentVerification;
 try { receipt = JSON.parse(raw); } catch { return; }
 if (!receipt || typeof receipt !== "object") return;
 if (receipt.version !== 1 || receipt.agent !== options.agent || receipt.trustMode !== "normal-client-policy" || !Number.isFinite(Date.parse(receipt.checkedAt)) || !/^[a-f0-9]{64}$/.test(receipt.sessionHash) || typeof receipt.nativeVersion !== "string" || !receipt.nativeVersion.trim() || receipt.checks?.contextDelivered !== true || receipt.checks.exactCitation !== true || receipt.checks.noToolCalls !== true) return;
 if (receipt.definitionHash !== await agentDefinitionHash(options)) return;
 return receipt;
}
export async function writeAgentVerification(options: VerificationInstallation, receipt: AgentVerification) {
 if (receipt.definitionHash !== await agentDefinitionHash(options)) return false;
 await writeManagedFile(location(options), JSON.stringify(receipt) + "\n");
 return true;
}

export async function beginAgentVerification(options: VerificationInstallation) {
 await writeManagedFile(location(options), JSON.stringify({ version: 1, agent: options.agent, status: "unverified", startedAt: new Date().toISOString() }) + "\n");
}
