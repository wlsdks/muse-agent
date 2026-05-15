import {
  AnthropicProvider,
  DiagnosticModelProvider,
  GeminiProvider,
  knownModelPrefixes,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  parseModelName,
  type ModelProvider
} from "@muse/model";

import { parseCsv, parseInteger, parseOptionalString } from "./env-parsers.js";
import type { MuseEnvironment } from "./index.js";

/**
 * Resolve the default model identifier the runtime should use.
 *
 * Priority: explicit `MUSE_MODEL` (or `MUSE_DEFAULT_MODEL`) wins.
 * Otherwise infer from whichever provider API key is in env, in
 * preference order: GEMINI / GOOGLE → OPENAI → ANTHROPIC → OPENROUTER.
 * Returns undefined when no signal at all is available — the runtime
 * stays disabled and the boot script logs a clear warning.
 *
 * Personal-JARVIS UX: a user who exports `GEMINI_API_KEY` once and
 * runs `node apps/api/dist/index.js` should get a working `/api/chat`
 * endpoint without setting any further env.
 */
export function resolveDefaultModel(env: MuseEnvironment): string | undefined {
  const explicit = parseOptionalString(env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL);
  if (explicit) {
    return explicit;
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
        baseUrl,
        defaultModel,
        models,
        numCtx: parseInteger(env.MUSE_OLLAMA_NUM_CTX, 8192)
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
