import { isAbsolute, relative, resolve } from "node:path";

export const SETUP_CONFIG_VERSION = 1 as const;

export interface SetupConfiguration {
	configVersion: typeof SETUP_CONFIG_VERSION;
	archiveRoot: string;
	stateRoot: string;
	launchAgentPath: string;
}

export type SetupConfigurationInput = Omit<SetupConfiguration, "configVersion"> & { configVersion?: number };

function safePath(value: string, field: string): string {
	if (!value || !isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
	const normalized = resolve(value);
	const forbidden = ["node_modules", ".bun", ".git", "src"];
	if (forbidden.some((part) => normalized.split(String.fromCharCode(47)).includes(part)))
		throw new Error(`${field} must not be inside a checkout, dependency, or Bun filesystem`);
	return normalized;
}

function contained(parent: string, child: string): boolean {
	const value = relative(parent, child);
	return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function normalizeSetupConfiguration(input: SetupConfigurationInput): SetupConfiguration {
	if (input.configVersion !== undefined && input.configVersion !== SETUP_CONFIG_VERSION)
		throw new Error(`unsupported configuration version: ${input.configVersion}`);
	const archiveRoot = safePath(input.archiveRoot, "archiveRoot");
	const stateRoot = safePath(input.stateRoot, "stateRoot");
	const launchAgentPath = safePath(input.launchAgentPath, "launchAgentPath");
	if (archiveRoot === stateRoot || contained(archiveRoot, stateRoot) || contained(stateRoot, archiveRoot))
		throw new Error("archiveRoot and stateRoot must not overlap");
	return { configVersion: SETUP_CONFIG_VERSION, archiveRoot, stateRoot, launchAgentPath };
}
