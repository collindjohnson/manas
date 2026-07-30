import { describe, expect, test } from "bun:test";
import { installCompiledBinary, type BinaryInstallerDependencies } from "@manas/installer";

function dependencies(files: Record<string, { hash: string; version: string }>, failRename = false): BinaryInstallerDependencies {
	const key = (path: string) => path.split(String.fromCharCode(47)).at(-1)!;
	return {
		hash: async (path) => files[key(path)]?.hash ?? "missing",
		version: async (path) => files[key(path)]?.version ?? "missing",
		copy: async (source, target) => { files[key(target)] = { ...files[key(source)]! }; },
		fsync: async () => {},
		chmod: async () => {},
		rename: async (source, target) => {
			if (failRename && key(target) === "destination" && key(source).startsWith("destination.stage")) throw new Error("rename interrupted");
			files[key(target)] = files[key(source)]!;
			delete files[key(source)];
		},
		remove: async (path) => { delete files[key(path)]; },
		ensureDirectory: async () => {},
		exists: async (path) => key(path) in files,
	};
}

describe("compiled binary installer", () => {
	test("installs, then reports an identical binary unchanged", async () => {
		const files = { source: { hash: "a", version: "1.0.0" } };
		const deps = dependencies(files);
		expect((await installCompiledBinary({ source: "source", destination: "destination", version: "1.0.0", dependencies: deps })).status).toBe("installed");
		expect((await installCompiledBinary({ source: "source", destination: "destination", version: "1.0.0", dependencies: deps })).status).toBe("unchanged");
	});

	test("rolls back the prior binary when final replacement fails", async () => {
		const files = { source: { hash: "new", version: "2.0.0" }, destination: { hash: "old", version: "1.0.0" } };
		await expect(installCompiledBinary({ source: "source", destination: "destination", version: "2.0.0", dependencies: dependencies(files, true) })).rejects.toThrow("interrupted");
		expect(files.destination).toEqual({ hash: "old", version: "1.0.0" });
	});

	test("refuses self-installation from source execution", async () => {
		const slash = String.fromCharCode(47);
		const child = Bun.spawn([process.execPath, "src" + slash + "cli.ts", "install"], {
			cwd: import.meta.dir + slash + "..",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await child.exited).toBe(1);
		expect(await new Response(child.stdout).text()).toContain("self-install requires an installed release binary");
	});
});
