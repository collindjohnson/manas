import { test, expect } from "bun:test";
import { defaultConfig } from "../src/config";
import { assertLocalInferenceConfig } from "../src/brain/local-inference";
import { createBrainProviders } from "../src/engine";

for (const kind of ["generation", "embedding", "reranking", "transcription", "extraction"] as const) test(kind + " rejects cloud model selectors on loopback before creating inference providers", () => {
 const base = defaultConfig({});
 for (const model of ["fixture:cloud", "fixture:235b-cloud", "fixture:CLOUD"]) {
  const config = { ...base, providers: { [kind]: { endpoint: "http://127.0.0.1:11434/v1/chat/completions", model, privacy: "local" as const, ...(kind === "embedding" ? { dimensions: 2 } : {}) } } };
  expect(() => createBrainProviders(config)).toThrow("cloud-backed");
  try { assertLocalInferenceConfig(config); throw new Error("Expected a local inference configuration error"); }
  catch (error) { expect(error).toMatchObject({ code: "local_model_not_configured", retryable: false, suggestedFix: expect.stringContaining("providers." + kind) }); }
 }
 expect(() => assertLocalInferenceConfig({ ...base, providers: { [kind]: { endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "my-cloud-research:latest", privacy: "local" } } })).not.toThrow();
});

test("active legacy cloud providers are rejected while unused legacy configuration remains available", () => {
 const base = defaultConfig({});
 for (const kind of ["generation", "reranking"] as const) {
  const brain = { ...base.brain!, ...(kind === "generation" ? { generationEndpoint: "http://127.0.0.1:11434/v1/chat/completions", generationModel: "legacy:cloud" } : { rerankerEndpoint: "http://127.0.0.1:11434/v1/rerank", rerankerModel: "legacy:cloud" }) };
  const config = { ...base, brain };
  expect(() => assertLocalInferenceConfig(config)).toThrow("cloud-backed");
  expect(() => assertLocalInferenceConfig({ ...config, providers: { [kind]: { endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "installed:latest", privacy: "local" } } })).not.toThrow();
  expect(kind === "generation" ? brain.generationModel : brain.rerankerModel).toBe("legacy:cloud");
 }
});
