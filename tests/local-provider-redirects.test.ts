import { test, expect } from "bun:test";
import { diagnoseProvider, OpenAiCompatibleEmbeddingProvider, OpenAiCompatibleGenerationProvider, OpenAiCompatibleRerankerProvider, OpenAiCompatibleStructuredExtractionProvider, OpenAiCompatibleTranscriptionProvider } from "../src/brain/providers";

test("local inference and model health never follow a provider redirect", async () => {
 let destinationRequests = 0, providerRequests = 0;
 const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { destinationRequests++; return Response.json({ choices: [{ message: { content: "unexpected" } }] }); } });
 const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { providerRequests++; return new Response(null, { status: 307, headers: { Location: "http://127.0.0.1:" + destination.port + "/unexpected-destination" } }); } });
 const endpoint = "http://127.0.0.1:" + provider.port + "/model";
 try {
  const calls = [
   () => new OpenAiCompatibleEmbeddingProvider({ id: "local", dimensions: 2 }, endpoint).embed(["private fixture"]),
   () => new OpenAiCompatibleGenerationProvider("local", endpoint).generate("private fixture"),
   () => new OpenAiCompatibleRerankerProvider("local", endpoint).rerank("private fixture", [{ id: "a", text: "private fixture" }]),
   () => new OpenAiCompatibleStructuredExtractionProvider("local", endpoint).extract("private fixture", { type: "object" }),
   () => new OpenAiCompatibleTranscriptionProvider("local", endpoint).transcribe(new Uint8Array([1, 2, 3]), "audio/wav"),
  ];
  for (const invoke of calls) await expect(invoke()).rejects.toThrow();
  expect(await diagnoseProvider({ endpoint })).toMatchObject({ reachable: false });
  expect(providerRequests).toBe(6);
  expect(destinationRequests).toBe(0);
 } finally { provider.stop(true); destination.stop(true); }
});
