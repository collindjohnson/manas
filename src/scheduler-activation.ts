import { resolve } from "node:path";

export interface SchedulerReceiptEvidence {
	executable: string;
	configPath: string;
	startedAt: string;
	status: "success" | "failed";
	report: unknown;
}

export interface SchedulerActivationDependencies {
	run(command: string[]): Promise<number>;
	waitForReceipt(after: string, timeoutMs: number): Promise<SchedulerReceiptEvidence | undefined>;
	verifyArchive?(): Promise<{ ok: boolean; errors: string[] }>;
	verifyLog?(): Promise<boolean>;
}

export interface SchedulerActivationRequest {
	plistPath: string;
	uid: number;
	label: string;
	executable: string;
	configPath: string;
	startedAt: string;
	timeoutMs?: number;
}

export async function activateAndVerifyMacScheduler(
	request: SchedulerActivationRequest,
	dependencies: SchedulerActivationDependencies,
): Promise<SchedulerReceiptEvidence> {
	const domain = `gui${String.fromCharCode(47)}${request.uid}`;
	const label = `${domain}${String.fromCharCode(47)}${request.label}`;
	const running = await dependencies.run(["launchctl", "print", label]);
	if (running === 0) {
		const unloaded = await dependencies.run(["launchctl", "bootout", label]);
		if (unloaded !== 0) throw new Error("could not reload the Manas LaunchAgent");
	}
	if (await dependencies.run(["launchctl", "bootstrap", domain, request.plistPath]) !== 0)
		throw new Error("could not load the Manas LaunchAgent");
	if (await dependencies.run(["launchctl", "kickstart", "-k", label]) !== 0)
		throw new Error("could not kickstart the Manas LaunchAgent");
	if (await dependencies.run(["launchctl", "print", label]) !== 0)
		throw new Error("could not verify the active Manas LaunchAgent");
	const receipt = await dependencies.waitForReceipt(request.startedAt, request.timeoutMs ?? 30_000);
	if (!receipt) throw new Error("scheduled sync receipt timed out after activation");
	if (receipt.status !== "success") throw new Error("scheduled sync failed after activation");
	if (resolve(receipt.executable) !== resolve(request.executable))
		throw new Error("scheduled receipt used an unexpected executable");
	if (resolve(receipt.configPath) !== resolve(request.configPath))
		throw new Error("scheduled receipt used an unexpected configuration");
	if (dependencies.verifyArchive) {
		const archive = await dependencies.verifyArchive();
		if (!archive.ok)
			throw new Error(`scheduled archive verification failed: ${archive.errors.join("; ")}`);
	}
	if (dependencies.verifyLog && !(await dependencies.verifyLog()))
		throw new Error("scheduled log verification failed after activation");
	return receipt;
}
