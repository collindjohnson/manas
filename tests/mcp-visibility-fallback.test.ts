import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { BrainRepository } from "../src/brain/repository";
import { handleMcpHttpRequest } from "../src/mcp/http";
test("legacy HTTP repository calls retain delegated visibility grants", async () => {
 const root = await mkdtemp(join(tmpdir(), "manas-http-grants-"));
 const previous = process.env.MANAS_BRAIN_REPOSITORY;
 try {
  const repository = new BrainRepository(join(root, "brain"));
  await repository.initialize();
  const run = promisify(execFile);
  await run("git", ["-C", repository.root, "config", "user.name", "Test"]);
  await run("git", ["-C", repository.root, "config", "user.email", "test@example.invalid"]);
  const page = await repository.putPage("notes/private.md", "Private secret");
  await repository.setPageAccessLabels(page.path, ["private"], page.revision);
  await repository.putPage("notes/public.md", "Public evidence");
  process.env.MANAS_BRAIN_REPOSITORY = repository.root;
  const context = { scope: "read" as const, authorize: () => ({ allowedAccessLabels: [] }) };
  const request = (name: string, args: Record<string, unknown>) => handleMcpHttpRequest({}, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, undefined, context);
  const result = await request("list_pages", {}) as { content: Array<{ text: string }> };
  expect(JSON.parse(result.content[0].text).pages.map((value: { path: string }) => value.path)).toEqual(["notes/public.md"]);
  await expect(request("get_page", { path: "notes/private.md" })).rejects.toThrow("unavailable");
  await expect(request("search", { query: "secret" })).rejects.toThrow("configured operation registry");
 } finally {
  if (previous === undefined) delete process.env.MANAS_BRAIN_REPOSITORY; else process.env.MANAS_BRAIN_REPOSITORY = previous;
  await rm(root, { recursive: true, force: true });
 }
});
