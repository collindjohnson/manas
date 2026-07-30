import { resolve } from "node:path";

export interface ExecutableRuntime {
	execPath: string;
	bunPath?: string;
	entrypoint: string;
}

export function isCompiledExecutable(entrypoint: string): boolean {
	return ![".ts", ".tsx", ".js", ".mjs", ".cjs"].some((extension) => entrypoint.endsWith(extension));
}

export function executableCommand(runtime: ExecutableRuntime = { execPath: process.execPath, bunPath: Bun.which("bun") ?? undefined, entrypoint: import.meta.path }): string[] {
	const compiled = isCompiledExecutable(runtime.entrypoint);
	if (compiled) return [resolve(runtime.execPath)];
	if (!runtime.bunPath) throw new Error("a physical Bun executable is required for source execution");
	return [resolve(runtime.bunPath), resolve(runtime.entrypoint)];
}
