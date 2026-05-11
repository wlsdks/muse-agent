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

import { parseCsv, parseOptionalString } from "./env-parsers.js";
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
  if (parseOptionalString(env.GROQ_API_KEY)) {
    return "groq/llama-3.3-70b-versatile";
  }
  if (parseOptionalString(env.DEEPSEEK_API_KEY)) {
    return "deepseek/deepseek-chat";
  }
  if (parseOptionalString(env.MISTRAL_API_KEY)) {
    return "mistral/mistral-small-latest";
  }
  if (parseOptionalString(env.MOONSHOT_API_KEY)) {
    return "moonshot/moonshot-v1-8k";
  }
  if (parseOptionalString(env.TOGETHER_API_KEY)) {
    return "together/meta-llama/Llama-3.3-70B-Instruct-Turbo";
  }
  return undefined;
}

/**
 * Build a `ModelProvider` instance from the resolved default model
 * + provider-specific env. Falls through to `OpenAICompatibleProvider`
 * when an unknown providerId is paired with `MUSE_MODEL_BASE_URL`
 * (the local Ollama / LM Studio / vLLM path).
 */
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
        models
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
    case "groq":
      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.GROQ_API_KEY),
        baseUrl: baseUrl ?? "https://api.groq.com/openai/v1",
        defaultModel,
        id: "groq",
        models
      });
    case "deepseek":
      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.DEEPSEEK_API_KEY),
        baseUrl: baseUrl ?? "https://api.deepseek.com/v1",
        defaultModel,
        id: "deepseek",
        models
      });
    case "together":
      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.TOGETHER_API_KEY),
        baseUrl: baseUrl ?? "https://api.together.xyz/v1",
        defaultModel,
        id: "together",
        models
      });
    case "mistral":
      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.MISTRAL_API_KEY),
        baseUrl: baseUrl ?? "https://api.mistral.ai/v1",
        defaultModel,
        id: "mistral",
        models
      });
    case "moonshot":
      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.MOONSHOT_API_KEY),
        baseUrl: baseUrl ?? "https://api.moonshot.ai/v1",
        defaultModel,
        id: "moonshot",
        models
      });
    default:
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
