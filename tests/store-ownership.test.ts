import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStoreOwnership, StoreOwnedError } from "../src/brain/ownership";
import { openPgliteBrainStore } from "../src/brain/store";

test("exclusive ownership covers aliases and releases on close", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-owner-"));
	try {
		const release = await acquireStoreOwnership(join(root, "store"));
		try {
			await symlink(join(root, "store"), join(root, "alias"));
			await expect(acquireStoreOwnership(join(root, "alias"))).rejects.toBeInstanceOf(StoreOwnedError);
		} finally { release(); release(); }
		(await acquireStoreOwnership(join(root, "store")))();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("kernel releases ownership after a killed process", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-owner-crash-"));
	const script = "import { acquireStoreOwnership } from " + JSON.stringify(join(process.cwd(), "src/brain/ownership.ts")) + "; await acquireStoreOwnership(" + JSON.stringify(root) + "); console.log(\"locked\"); setInterval(() => {}, 1000);";
	const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
	try {
		const reader = child.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("locked");
		await expect(acquireStoreOwnership(root)).rejects.toBeInstanceOf(StoreOwnedError);
		child.kill("SIGKILL");
		await child.exited;
		(await acquireStoreOwnership(root))();
	} finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
});

test("PGLite uses ownership and releases it after initialization errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "manas-store-owner-"));
	try {
		const store = await openPgliteBrainStore(root);
		try { await expect(openPgliteBrainStore(root)).rejects.toBeInstanceOf(StoreOwnedError); }
		finally { await store.close(); }
		const reopened = await openPgliteBrainStore(root);
		await reopened.exec("UPDATE brain_schema_meta SET value = '999' WHERE key = 'schema_version'");
		await reopened.close();
		await expect(openPgliteBrainStore(root)).rejects.toThrow("newer than supported");
		(await acquireStoreOwnership(root))();
	} finally { await rm(root, { recursive: true, force: true }); }
});
