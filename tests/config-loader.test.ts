import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("configuration loader", () => {
	test("applies defaults, file, environment, then explicit values", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-config-"));
		try {
			const path = join(root, "config.json");
			await writeFile(path, JSON.stringify({ archiveRoot: "/file/archive", brain: { retrievalLimit: 7, chunkMaxChars: 9_000, generationModel: "file-model" } }));
			const config = await loadConfig({
				filePath: path,
				environment: { MANAS_ARCHIVE: "/environment/archive", MANAS_RETRIEVAL_LIMIT: "11", MANAS_GENERATION_MODEL: "environment-model" },
				explicit: { archiveRoot: "/explicit/archive", brain: { retrievalLimit: 13 } },
			});
			expect(config.archiveRoot).toBe("/explicit/archive");
			expect(config.brain?.retrievalLimit).toBe(13);
			expect(config.brain?.chunkMaxChars).toBe(9_000);
			expect(config.brain?.generationModel).toBe("environment-model");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects malformed configuration files", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-config-"));
		try {
			const path = join(root, "config.json");
			await writeFile(path, "[]");
			await expect(loadConfig({ filePath: path })).rejects.toThrow("object");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("loads the versioned configuration written by setup", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-config-"));
		try {
			const path = join(root, "config.json");
			await writeFile(path, JSON.stringify({
				configVersion: 1,
				archiveRoot: join(root, "archive"),
				stateRoot: join(root, "state"),
				launchAgentPath: join(root, "agent.plist"),
			}));
			const config = await loadConfig({ filePath: path, environment: {} });
			expect(config.archiveRoot).toBe(join(root, "archive"));
			expect(config).not.toHaveProperty("configVersion");
			await writeFile(path, JSON.stringify({ configVersion: 2 }));
			await expect(loadConfig({ filePath: path, environment: {} })).rejects.toThrow("unsupported configuration version");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not allow a file to bypass bounded retrieval settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-config-"));
		try {
			const path = join(root, "config.json");
			await writeFile(path, JSON.stringify({ brain: { retrievalLimit: 10_000 } }));
			await expect(loadConfig({ filePath: path })).rejects.toThrow("retrieval limits");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("loads provider and auth settings with environment precedence", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-config-"));
		try {
			const path = join(root, "config.json");
			await writeFile(path, JSON.stringify({
				providers: {
					embedding: { endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "file-embedding", privacy: "local", dimensions: 3 },
				},
				auth: { oauth: { allowedOrigin: "http://127.0.0.1" }, session: { idleMs: 4_000 } },
			}));
			const config = await loadConfig({ filePath: path, environment: {
				MANAS_PROVIDER_EMBEDDING_MODEL: "environment-embedding",
				MANAS_PROVIDER_EMBEDDING_DIMENSIONS: "4",
				MANAS_SESSION_ABSOLUTE_MS: "8000",
			} });
			expect(config.providers?.embedding).toMatchObject({ endpoint: "http://127.0.0.1:11434/v1/embeddings", model: "environment-embedding", dimensions: 4, privacy: "local" });
			expect(config.auth).toMatchObject({ oauth: { allowedOrigin: "http://127.0.0.1" }, session: { idleMs: 4_000, absoluteMs: 8_000 } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a hosted endpoint accidentally labeled local", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-config-"));
		try {
			const path = join(root, "config.json");
			await writeFile(path, JSON.stringify({ providers: { generation: { endpoint: "https://provider.invalid/v1", model: "remote", privacy: "local" } } }));
			await expect(loadConfig({ filePath: path })).rejects.toThrow("loopback");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects unknown file settings instead of silently dropping them", async () => {
		const root = await mkdtemp(join(tmpdir(), "brain-config-"));
		try {
			const path = join(root, "config.json");
			await writeFile(path, JSON.stringify({ unexpected: true }));
			await expect(loadConfig({ filePath: path })).rejects.toThrow("unknown setting");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
