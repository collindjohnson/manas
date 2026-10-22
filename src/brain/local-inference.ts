import type { Config } from "../config";

export class LocalModelConfigurationError extends Error {
 readonly code = "local_model_not_configured";
 readonly retryable = false;
 constructor(message = "Local generation is unavailable. Configure providers.generation with a running local model.", readonly suggestedFix = "Configure providers.generation with a loopback endpoint, local model, and privacy set to local.") { super(message); }
}
export function assertLocalInferenceConfig(config: Config): void {
 const providers = { ...config.providers };
 // Legacy configuration is retained, but only an active legacy provider is inference configuration.
 for (const kind of ["generation", "reranking"] as const) {
  const model = kind === "generation" ? config.brain?.generationModel : config.brain?.rerankerModel;
  const endpoint = kind === "generation" ? config.brain?.generationEndpoint : config.brain?.rerankerEndpoint;
  if (!providers[kind] && model && endpoint) providers[kind] = { model, endpoint, privacy: "local" };
 }
 for (const [kind, provider] of Object.entries(providers)) {
  const suggestedFix = "Configure providers." + kind + " with a loopback endpoint, an installed local model, and privacy set to local.";
  if (provider?.privacy === "hosted") throw new LocalModelConfigurationError("Manas inference must stay local: configure a local " + kind + " provider.", suggestedFix);
  // Ollama can route these named models to its cloud even through a loopback API.
  if (typeof provider?.model === "string" && /(?:[:\-])cloud$/i.test(provider.model.trim())) throw new LocalModelConfigurationError("Manas inference cannot use a cloud-backed " + kind + " model.", suggestedFix);
 }
}
