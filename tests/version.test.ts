import { expect, test } from "bun:test";
import { handleMcpHttpRequest, MCP_PROTOCOL_VERSION } from "@manas/mcp/http";
import { MANAS_VERSION } from "@manas-version";

test("uses one package version for the CLI and HTTP MCP metadata", async () => {
	const manifest = JSON.parse(await Bun.file("package.json").text()) as { version: string };
	expect(MANAS_VERSION).toBe(manifest.version);
	const cli = Bun.spawn([process.execPath, ["src", "cli.ts"].join(String.fromCharCode(47)), "--version"], { stdout: "pipe", stderr: "pipe" });
	expect(await cli.exited).toBe(0);
	expect((await new Response(cli.stdout).text()).trim()).toBe(MANAS_VERSION);
	await expect(handleMcpHttpRequest({}, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: MCP_PROTOCOL_VERSION },
	})).resolves.toMatchObject({ serverInfo: { name: "manas", version: MANAS_VERSION } });
});
