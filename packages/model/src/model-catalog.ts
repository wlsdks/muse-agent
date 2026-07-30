/**
 * Static, queryable model CAPABILITY catalog — the index Muse lacked. Each adapter declares its
 * own `listModels()`, but there was no single place to ask "which models can I use, and which do
 * vision / tool-calling / run locally?" without a live provider call. This curates the models
 * Muse's router knows (the same provider defaults `autoconfigure-model-provider` resolves) into a
 * queryable `ModelInfo[]`, so `muse models` and the cloud-setup wizard can answer that offline.
 *
 * Reimplements the pattern of openclaw's `model-catalog-core` (MIT) in Muse's own `ModelInfo`
 * shape — curated to Muse's supported providers, not copied. Capability VALUES are config (kept
 * deliberately conservative); the QUERY functions below are the behavior under test.
 */

import type { ModelCapabilities, ModelInfo } from "./index.js";

/** The boolean capability keys a catalog query can filter on. */
export type BooleanCapability = "streaming" | "toolCalling" | "structuredOutput" | "vision" | "reasoning" | "promptCaching" | "local";

function caps(over: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    cost: "unknown",
    latencyProfile: "unknown",
    local: false,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    promptCaching: false,
    reasoning: false,
    streaming: false,
    structuredOutput: false,
    toolCalling: false,
    vision: false,
    ...over
  };
}

export const MODEL_CATALOG: readonly ModelInfo[] = [
  { capabilities: caps({ cost: "free", latencyProfile: "balanced", local: true, maxInputTokens: 128_000, maxOutputTokens: 8_192, streaming: true, structuredOutput: true, toolCalling: true, vision: true }), displayName: "Gemma 4 12B (Muse default)", modelId: "gemma4:12b", providerId: "ollama" },
  { capabilities: caps({ cost: "free", latencyProfile: "balanced", local: true, maxInputTokens: 128_000, maxOutputTokens: 8_192, streaming: true, toolCalling: true }), displayName: "Llama 3.2", modelId: "llama3.2", providerId: "ollama" },
  { capabilities: caps({ cost: "low", latencyProfile: "interactive", maxInputTokens: 1_000_000, maxOutputTokens: 8_192, promptCaching: true, streaming: true, structuredOutput: true, toolCalling: true, vision: true }), displayName: "Gemini 2.0 Flash", modelId: "gemini-2.0-flash", providerId: "gemini" },
  { capabilities: caps({ cost: "low", latencyProfile: "interactive", maxInputTokens: 128_000, maxOutputTokens: 16_384, promptCaching: true, streaming: true, structuredOutput: true, toolCalling: true, vision: true }), displayName: "GPT-4o mini", modelId: "gpt-4o-mini", providerId: "openai" },
  { capabilities: caps({ cost: "low", latencyProfile: "interactive", maxInputTokens: 200_000, maxOutputTokens: 8_192, promptCaching: true, streaming: true, structuredOutput: true, toolCalling: true, vision: true }), displayName: "Claude Haiku 4.5", modelId: "claude-haiku-4-5-20251001", providerId: "anthropic" },
  { capabilities: caps({ cost: "low", latencyProfile: "interactive", maxInputTokens: 1_000_000, maxOutputTokens: 8_192, streaming: true, toolCalling: true, vision: true }), displayName: "Gemini 2.0 Flash (OpenRouter)", modelId: "google/gemini-2.0-flash-001", providerId: "openrouter" }
];

/** The `<providerId>/<modelId>` spec the router + CLI config use. */
export function modelSpec(model: ModelInfo): string {
  return `${model.providerId}/${model.modelId}`;
}

/** Look a catalog entry up by its provider + model id (or its full `<provider>/<model>` spec). */
export function findCatalogModel(spec: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => modelSpec(m) === spec);
}

/** Catalog models that have a given boolean capability (vision / toolCalling / local / …). */
export function catalogModelsByCapability(capability: BooleanCapability): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.capabilities[capability] === true);
}

/** Catalog models served by a given provider id. */
export function catalogModelsByProvider(providerId: string): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.providerId === providerId);
}

/** Catalog models that run locally (no cloud egress) — the local-only subset. */
export function localCatalogModels(): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.capabilities.local);
}
