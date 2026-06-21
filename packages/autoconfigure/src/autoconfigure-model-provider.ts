import {
  AnthropicProvider,
  classifyProviderLocality,
  DEFAULT_OLLAMA_NUM_CTX,
  DiagnosticModelProvider,
  GeminiProvider,
  knownModelPrefixes,
  LocalOnlyViolationError,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  parseModelName,
  type ModelProvider
} from "@muse/model";

import { parseBoolean, parseCsv, parseInteger, parseNonNegativeFloat, parseOptionalString } from "./env-parsers.js";

/**
 * Temperature for Muse's user-facing ANSWER generation (chat / ask). Set
 * EXPLICITLY (not left to the model's Ollama Modelfile default) so a grounding-
 * first assistant doesn't silently inherit a high default — gemma4:12b ships
 * `temperature 1.0`, qwen3:8b shipped 0.6; relying on the model default meant
 * the gemma4 swap quietly raised answer temperature (more variance / fabrication
 * risk). 0.6 is the grounding-friendly value Muse's recall edge was proven on;
 * `MUSE_ANSWER_TEMPERATURE` overrides. (Tool-selection / reverify paths still
 * pin temperature 0 explicitly — this is only the unspecified-answer default.)
 */
export function resolveAnswerTemperature(env: MuseEnvironment): number {
  return parseNonNegativeFloat(env.MUSE_ANSWER_TEMPERATURE, 0.6);
}
import type { MuseEnvironment } from "./index.js";

/**
 * The zero-config local model for a local-first install (Ollama + Gemma 4 12B).
 * Chosen over qwen3:8b on measured edge: stricter grounding (faithfulness 0.94
 * vs 0.88 on the held-out corpus) AND native multimodal (vision / document /
 * OCR / chart) — the future capability unlock — at the cost of ~38% slower
 * generation and a tool-selection gap that Muse's tool descriptions are being
 * tuned to close. Still fully local (Ollama), so the local-only stance holds.
 */
export const LOCAL_FIRST_DEFAULT_MODEL = "ollama/gemma4:12b";

/**
 * Resolve the default model identifier the runtime should use.
 *
 * Priority: explicit `MUSE_MODEL` (or `MUSE_DEFAULT_MODEL`) wins.
 *
 * LOCAL-FIRST: when local-only is on (the default posture), the zero-config
 * default is the LOCAL model — never a cloud one. This is the whole product
 * stance ("runs entirely on your machine") AND it fixes a real trap: inferring
 * a cloud model from an ambient `GEMINI_API_KEY`/`OPENAI_API_KEY` would then be
 * REFUSED by the local-only gate, so zero-config broke on any box that happened
 * to carry a cloud key. Cloud-credential inference (GEMINI → OPENAI → ANTHROPIC
 * → OPENROUTER → local) applies ONLY when the user explicitly opts out via
 * `MUSE_LOCAL_ONLY=false`. Returns undefined only in the opted-out case with no
 * signal at all.
 */
export function resolveDefaultModel(env: MuseEnvironment): string | undefined {
  const explicit = parseOptionalString(env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL);
  if (explicit) {
    return explicit;
  }
  if (parseBoolean(env.MUSE_LOCAL_ONLY, true)) {
    return LOCAL_FIRST_DEFAULT_MODEL;
  }
  return inferDefaultModelFromCredentials(env);
}

function inferDefaultModelFromCredentials(env: MuseEnvironment): string | undefined {
  if (parseOptionalString(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY)) {
    return "gemini/gemini-2.0-flash";
  }
  if (parseOptionalString(env.OPENAI_API_KEY)) {
    return "openai/gpt-4o-mini";
  }
  if (parseOptionalString(env.ANTHROPIC_API_KEY)) {
    return "anthropic/claude-haiku-4-5-20251001";
  }
  if (parseOptionalString(env.OPENROUTER_API_KEY)) {
    return "openrouter/google/gemini-2.0-flash-001";
  }
  if (parseOptionalString(env.OLLAMA_BASE_URL)) {
    return "ollama/llama3.2";
  }
  for (const preset of Object.values(OPENAI_COMPAT_PRESETS)) {
    if (parseOptionalString(env[preset.envKey])) {
      return preset.defaultModel;
    }
  }
  return undefined;
}

/**
 * Build a `ModelProvider` instance from the resolved default model
 * + provider-specific env. Falls through to `OpenAICompatibleProvider`
 * when an unknown providerId is paired with `MUSE_MODEL_BASE_URL`
 * (the local Ollama / LM Studio / vLLM path).
 */
import { OPENAI_COMPAT_PRESETS } from "./openai-compat-presets.js";

/**
 * `OllamaProvider` expects the OpenAI-compat `…/v1` base, but the
 * conventional `OLLAMA_BASE_URL` (matching the CLI's resolveOllamaUrl)
 * is the bare host with no `/v1`. Trim trailing slashes and append a
 * single `/v1` so either form works; undefined when unset so the
 * provider keeps its own 127.0.0.1 default.
 */
function normalizeOllamaBaseUrl(raw: string | undefined): string | undefined {
  const value = parseOptionalString(raw)?.replace(/\/+$/u, "");
  if (!value) {
    return undefined;
  }
  return /\/v1$/u.test(value) ? value : `${value}/v1`;
}

function providerIdFromPrefix(modelSpec: string): string | undefined {
  const lower = modelSpec.toLowerCase();
  for (const [prefix, providerId] of Object.entries(knownModelPrefixes())) {
    if (lower.startsWith(prefix)) {
      return providerId;
    }
  }
  return undefined;
}

export function createModelProvider(env: MuseEnvironment): ModelProvider | undefined {
  const defaultModel = resolveDefaultModel(env);
  const baseUrl = parseOptionalString(env.MUSE_MODEL_BASE_URL);

  if (!defaultModel) {
    return undefined;
  }

  const explicitProviderId = parseOptionalString(env.MUSE_MODEL_PROVIDER_ID);
  const providerId = explicitProviderId
    ?? (baseUrl ? "openai-compatible" : parseModelName(defaultModel).providerId)
    ?? (baseUrl ? "openai-compatible" : providerIdFromPrefix(defaultModel))
    ?? "openai-compatible";
  const models = parseCsv(env.MUSE_MODEL_LIST) ?? [parseModelName(defaultModel).modelId];

  // Local-only / no-cloud-egress: fail CLOSED (and loud) before any
  // cloud provider is instantiated. Silently disabling the runtime would
  // hide the privacy violation the user asked to be protected from.
  // DEFAULT ON: Muse is local-by-construction ("Tell it everything. It can't
  // tell anyone." — the README identity). A cloud provider is an explicit
  // opt-out via MUSE_LOCAL_ONLY=false that forfeits the zero-egress guarantee.
  if (parseBoolean(env.MUSE_LOCAL_ONLY, true)) {
    const effectiveBaseUrl = providerId === "ollama"
      ? (baseUrl ?? normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL))
      : OPENAI_COMPAT_PRESETS[providerId]
        ? (baseUrl ?? OPENAI_COMPAT_PRESETS[providerId].baseUrl)
        : baseUrl;
    if (classifyProviderLocality(providerId, effectiveBaseUrl) !== "local") {
      throw new LocalOnlyViolationError(providerId, effectiveBaseUrl);
    }
  }

  switch (providerId) {
    case "diagnostic":
      return new DiagnosticModelProvider({
        defaultModel,
        models
      });
    case "anthropic":
      return new AnthropicProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.ANTHROPIC_API_KEY),
        baseUrl,
        defaultModel,
        models
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY),
        baseUrl,
        defaultModel,
        models
      });
    case "ollama":
      return new OllamaProvider({
        // `OLLAMA_BASE_URL` is the conventional Ollama env (and what
        // the CLI's resolveOllamaUrl honours) — without this its
        // value was discarded and a remote/custom host silently fell
        // back to 127.0.0.1. `MUSE_MODEL_BASE_URL` still wins.
        baseUrl: baseUrl ?? normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL),
        defaultModel,
        models,
        numCtx: parseInteger(env.MUSE_OLLAMA_NUM_CTX, DEFAULT_OLLAMA_NUM_CTX),
        // Opt-in only: absent env → undefined → adapter omits `num_batch`
        // → Ollama's default. A junk value parses to 0, which the adapter
        // rejects (>0), so it also falls back to the default.
        ...(env.MUSE_OLLAMA_NUM_BATCH !== undefined
          ? { numBatch: parseInteger(env.MUSE_OLLAMA_NUM_BATCH, 0) }
          : {})
      });
    case "openai":
      return new OpenAIProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENAI_API_KEY),
        baseUrl,
        defaultModel,
        models
      });
    case "openrouter":
      return new OpenRouterProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENROUTER_API_KEY),
        appName: parseOptionalString(env.MUSE_APP_NAME) ?? "Muse",
        baseUrl,
        defaultModel,
        models,
        siteUrl: parseOptionalString(env.MUSE_SITE_URL)
      });
    default:
      if (OPENAI_COMPAT_PRESETS[providerId]) {
        const preset = OPENAI_COMPAT_PRESETS[providerId];
        return new OpenAICompatibleProvider({
          apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env[preset.envKey]),
          baseUrl: baseUrl ?? preset.baseUrl,
          defaultModel,
          id: providerId,
          models
        });
      }
      if (!baseUrl) {
        return undefined;
      }

      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENAI_API_KEY),
        baseUrl,
        defaultModel,
        id: providerId,
        models
      });
  }
}
