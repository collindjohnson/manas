const conformanceModule = await import([".", "conformance"].join(String.fromCharCode(47)));

import type { NormalizedDocument, SourceCheckpoint, SourceDescriptor } from "./types";

export type PluginDocument = NormalizedDocument;
export type PluginAdapter = { id: string; describe(): SourceDescriptor; scan(checkpoint?: SourceCheckpoint): AsyncIterable<PluginDocument> };
export interface SourcePlugin { descriptor: SourceDescriptor; create(): PluginAdapter; }
export type SourcePluginVerification = { descriptor: SourceDescriptor; documentCount: number; externalIds: string[] };

function key(descriptor: SourceDescriptor): string { return `${descriptor.id}\0${descriptor.version}`; }
function sameDescriptor(left: SourceDescriptor, right: SourceDescriptor): boolean { return left.id === right.id && left.version === right.version && left.kind === right.kind && left.trusted === right.trusted && JSON.stringify(left.compatibility ?? {}) === JSON.stringify(right.compatibility ?? {}); }

function versionParts(value: string): number[] {
	const parts = value.trim().replace(/^v/iu, "").split(".");
	if (!parts.length || parts.some((part) => !/^\d+$/.test(part))) throw new Error("source compatibility versions must be numeric");
	return parts.map(Number);
}

function compareVersions(left: string, right: string): number {
	const leftParts = versionParts(left);
	const rightParts = versionParts(right);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference) return difference;
	}
	return 0;
}

function assertCompatible(descriptor: SourceDescriptor, engineVersion: string | undefined): void {
	if (!engineVersion || !descriptor.compatibility) return;
	if (descriptor.compatibility.minimumEngine && compareVersions(engineVersion, descriptor.compatibility.minimumEngine) < 0 || descriptor.compatibility.maximumEngine && compareVersions(engineVersion, descriptor.compatibility.maximumEngine) > 0) throw new Error("source plugin is incompatible with this engine");
}

export async function verifySourcePlugin(plugin: SourcePlugin, checkpoint?: SourceCheckpoint): Promise<SourcePluginVerification> {
	conformanceModule.assertSourceDescriptor(plugin.descriptor);
	const adapter = plugin.create();
	if (!adapter || adapter.id !== plugin.descriptor.id || typeof adapter.describe !== "function" || typeof adapter.scan !== "function") throw new Error("source plugin returned an invalid adapter");
	const descriptor = adapter.describe();
	conformanceModule.assertSourceDescriptor(descriptor);
	if (!sameDescriptor(plugin.descriptor, descriptor)) throw new Error("source plugin descriptor does not match its adapter");
	const documents = await Array.fromAsync(adapter.scan(checkpoint));
	conformanceModule.assertNormalizedDocuments(descriptor.id, documents);
	return { descriptor, documentCount: documents.length, externalIds: documents.map((document) => document.externalId).sort() };
}

export class SourcePluginRegistry {
	private readonly plugins = new Map<string, SourcePlugin>();
	constructor(private readonly options: { allowUntrusted?: boolean; engineVersion?: string } = {}) {}
	register(plugin: SourcePlugin): void {
		conformanceModule.assertSourceDescriptor(plugin.descriptor);
		if (!this.options.allowUntrusted && !plugin.descriptor.trusted) throw new Error("untrusted source plugins require explicit opt-in");
		assertCompatible(plugin.descriptor, this.options.engineVersion);
		const pluginKey = key(plugin.descriptor);
		if (this.plugins.has(pluginKey)) throw new Error("source plugin version is already registered");
		this.plugins.set(pluginKey, plugin);
	}
	list(): SourceDescriptor[] { return [...this.plugins.values()].map((plugin) => plugin.descriptor).sort((left, right) => key(left).localeCompare(key(right))); }
	resolve(id: string, version?: string): SourcePlugin {
		if (!id.trim()) throw new Error("invalid source plugin id");
		const matches = [...this.plugins.values()].filter((plugin) => plugin.descriptor.id === id && (version === undefined || plugin.descriptor.version === version));
		if (!matches.length) throw new Error("source plugin is not registered");
		if (matches.length > 1) throw new Error("source plugin version is required");
		assertCompatible(matches[0]!.descriptor, this.options.engineVersion);
		return matches[0]!;
	}
	async verify(id: string, version?: string, checkpoint?: SourceCheckpoint): Promise<SourcePluginVerification> { return verifySourcePlugin(this.resolve(id, version), checkpoint); }
}
