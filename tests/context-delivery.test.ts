import { expect, test } from "bun:test";
import { OperationRegistry } from "../src/brain/operation-registry";
import { deliverContext } from "../src/brain/context-delivery";

test("context delivery bounds escaped Unicode evidence and preserves exact source spans", async () => {
 const text = "Quoted\\\" evidence: 東京 😀 ".repeat(1_000);
 const citation = { tenantId: "local", brainId: "brain", documentId: "doc", documentRevision: "rev", revision: "rev", chunkId: "chunk", path: "notes/fact.md", commit: "commit", startOffset: 10, endOffset: text.length + 10, contentHash: "old", schemaPack: { id: "default", version: "1" } };
 const registry = new OperationRegistry();
 registry.register({ name: "retrieval.search", description: "Fixture retrieval", inputSchema: {}, outputSchema: {}, requiredScope: "read", trustBoundary: "remote-safe", execute: async (_context, input) => {
  expect(input).toMatchObject({ options: { mode: "keyword" } });
  return { results: [{ verifiedText: text, citation }] };
 } });
 const result = await deliverContext(registry, { scope: "read" }, { query: "evidence", maximumTokens: 500 });
 expect(result.outcome).toBe("delivered");
 expect(result.truncated).toBe(true);
 expect(result.estimatedTokens).toBeLessThanOrEqual(500);
 expect(Buffer.byteLength(result.context)).toBeLessThanOrEqual(1_500);
 const serialized = JSON.parse(result.context.split("\n")[1]!);
 expect(text.startsWith(serialized.text)).toBe(true);
 expect(serialized.citation.endOffset - serialized.citation.startOffset).toBe(serialized.text.length);
 expect(serialized.citation.contentHash).toBe(new Bun.CryptoHasher("sha256").update(serialized.text).digest("hex"));
});

test("context delivery returns promptly when retrieval is unavailable or stalls", async () => {
 const registry = new OperationRegistry();
 registry.register({ name: "retrieval.search", description: "Unavailable fixture", inputSchema: {}, outputSchema: {}, requiredScope: "read", trustBoundary: "remote-safe", execute: async () => new Promise(() => {}) });
 const started = Date.now();
 expect(await deliverContext(registry, { scope: "read" }, { query: "evidence", timeoutMs: 50 })).toMatchObject({ outcome: "unavailable", context: "", citations: [] });
 expect(Date.now() - started).toBeLessThan(500);
 await expect(deliverContext(registry, { scope: "read" }, { query: "x", maximumTokens: 2001 })).rejects.toThrow("budget");
});
