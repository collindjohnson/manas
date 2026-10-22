import { test, expect } from "bun:test";
import { OperationRegistry, scopedClientRegistry } from "../src/brain/operation-registry";
test("scoped agent registry fixes grants and excludes owner and mutation operations", async () => {
 const original = new OperationRegistry();
 const observed: unknown[] = [];
 for (const [name, scope, boundary] of [["read", "read", "remote-safe"], ["write", "write", "remote-safe"], ["admin", "admin", "remote-safe"], ["private", "read", "local-only"]] as const) {
  original.register({ name, description: name, inputSchema: {}, outputSchema: {}, requiredScope: scope, trustBoundary: boundary, execute: async (context) => { observed.push(context); return {}; } });
 }
 const scoped = scopedClientRegistry(original, { scope: "read", tenantId: "tenant", brainId: "brain", principal: "client", allowedAccessLabels: ["granted"] });
 expect(scoped.list().map((operation) => operation.name)).toEqual(["read"]);
 await scoped.execute({ scope: "admin", tenantId: "other", allowedAccessLabels: ["secret"] }, "read", {});
 expect(observed[0]).toMatchObject({ scope: "read", tenantId: "tenant", brainId: "brain", principal: "client", allowedAccessLabels: ["granted"] });
 await expect(scoped.execute({ scope: "admin" }, "write", {})).rejects.toThrow("not registered");
});

test("scoped client catalogs omit operational metadata without source visibility semantics", () => {
 const original = new OperationRegistry();
 for (const name of ["jobs.list", "jobs.schedules", "sources.list", "agent.status", "cache.inspect", "skills.feedback.list"]) original.register({ name, description: name, inputSchema: {}, outputSchema: {}, requiredScope: "read", trustBoundary: "remote-safe", execute: async () => ({ secret: "owner metadata" }) });
 expect(scopedClientRegistry(original, { scope: "read", allowedAccessLabels: [] }).list()).toEqual([]);
});
