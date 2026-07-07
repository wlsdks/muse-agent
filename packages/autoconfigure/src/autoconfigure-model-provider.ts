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

import { parseBoolean, parseCsv, parseHeaderMap, parseInteger, parseNonNegativeFloat, parseNonNegativeInteger, parseOptionalString } from "./env-parsers.js";

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
 * The zero-config VISION model. Muse's image surface (`muse ask --image`,
 * `--auto`/`--extract`, screen-read) can run a dedicated vision model rather than
 * inheriting the chat default, because the best local grounding-and-chat model is
 * not always the best local OCR/vision model. This is the winner of the checked-in
 * head-to-head (`eval:vision` / `eval:vision-grounding`, incl. the Korean
 * receipt/flyer fixtures).
 *
 * MEASURED 2026-07 — gemma4:12b vs qwen3-vl:8b, pass^3 on the Korean + English
 * fixtures: gemma4 = 6/6 actions + 5/5 grounding; qwen3-vl = 4/6 actions
 * (consistent EMPTY output on the constrained calendar/event schema — BOTH the
 * English AND Korean flyer, 3/3, so not a Hangul gap) + 5/5 grounding. gemma4
 * ALSO already handles the Korean receipt/flyer cleanly. So the flip is NOT
 * warranted: gemma4 stays the vision default and this equals `LOCAL_FIRST_DEFAULT_MODEL`.
 *
 * Keep it EQUAL to `LOCAL_FIRST_DEFAULT_MODEL` (a no-op swap) unless a future
 * measurement shows a different local model wins WITHOUT regressing any surface —
 * then a one-line change here flips it. The auto-swap only fires when the chat
 * default IS the local default (an explicit `--model` / cloud model is respected
 * as-is) and fails soft to the chat model when the chosen model isn't pulled.
 * The `MUSE_VISION_MODEL` env is the always-available manual override.
 */
export const LOCAL_FIRST_VISION_MODEL = LOCAL_FIRST_DEFAULT_MODEL;

function ollamaTag(modelId: string): string | undefined {
  return modelId.startsWith("ollama/") ? modelId.slice("ollama/".length) : undefined;
}

/**
 * Resolve which model the VISION surface should use for THIS session, given the
 * already-resolved chat/session model. Pure + deterministic so it is unit-testable
 * and the fail-soft path is pinned by a test:
 *
 *  1. Explicit `MUSE_VISION_MODEL` wins (any provider — the escape hatch).
 *  2. Else, when the session model is the LOCAL chat default, swap to
 *     `LOCAL_FIRST_VISION_MODEL` (the measured best local vision model). An
 *     explicit `--model`/`MUSE_MODEL` or a cloud model is RESPECTED unchanged —
 *     we never override a deliberate model choice for vision.
 *  3. FAIL-SOFT: if the chosen vision model differs from the session model, is an
 *     Ollama model, and `availableModels` is provided but does NOT contain it
 *     (the optional model isn't pulled), fall back to the session model — a
 *     missing optional model degrades gracefully, never crashes. When
 *     `availableModels` is omitted (couldn't query), the choice passes through
 *     and the vision primitive's own fail-soft (returns `{ ok:false }`, no throw)
 *     is the backstop.
 */
export function resolveVisionModel(params: {
  readonly sessionModel: string;
  readonly env: MuseEnvironment;
  readonly availableModels?: readonly string[];
}): string {
  const { sessionModel, env, availableModels } = params;
  const explicit = parseOptionalString(env.MUSE_VISION_MODEL);
  const desired = explicit ?? (sessionModel === LOCAL_FIRST_DEFAULT_MODEL ? LOCAL_FIRST_VISION_MODEL : sessionModel);
  if (desired === sessionModel) {
    return sessionModel;
  }
  const tag = ollamaTag(desired);
  if (tag !== undefined && availableModels !== undefined) {
    const have = new Set(availableModels.map((m) => ollamaTag(m) ?? m));
    if (!have.has(tag)) {
      return sessionModel;
    }
  }
  return desired;
}

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
 *
 * `MUSE_MODEL_EXTRA_HEADERS` (a JSON object string, e.g.
 * `'{"X-Gateway-Token":"abc123"}'`) is merged onto every request for
 * every provider family here — the surface a self-hosted LAN LLM
 * gateway (LiteLLM, a reverse proxy, Cloudflare-Access service-token
 * auth) needs when it requires a header beyond the standard
 * `Authorization: Bearer <apiKey>`. Absent/malformed → no extra
 * headers (`parseHeaderMap`'s fail-soft contract), never a boot abort.
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
  const extraHeaders = parseHeaderMap(env.MUSE_MODEL_EXTRA_HEADERS);

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
        ...(extraHeaders ? { headers: extraHeaders } : {}),
        models
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY),
        baseUrl,
        defaultModel,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
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
        ...(extraHeaders ? { headers: extraHeaders } : {}),
        models,
        numCtx: parseInteger(env.MUSE_OLLAMA_NUM_CTX, DEFAULT_OLLAMA_NUM_CTX),
        // Opt-in only: absent env → undefined → adapter omits `num_batch`
        // → Ollama's default. A junk value parses to 0, which the adapter
        // rejects (>0), so it also falls back to the default.
        ...(env.MUSE_OLLAMA_NUM_BATCH !== undefined
          ? { numBatch: parseInteger(env.MUSE_OLLAMA_NUM_BATCH, 0) }
          : {}),
        // Opt-in default generation cap (same omit-on-junk contract): caps
        // only requests with no explicit maxOutputTokens; absent → unbounded.
        ...(env.MUSE_OLLAMA_NUM_PREDICT !== undefined
          ? { numPredict: parseInteger(env.MUSE_OLLAMA_NUM_PREDICT, 0) }
          : {}),
        // num_thread: junk/0 → 0 → adapter rejects (>0). num_gpu uses the
        // non-negative parser so a literal "0" (CPU-only) is HONOURED; junk /
        // negative → -1 → adapter rejects (>=0).
        ...(env.MUSE_OLLAMA_NUM_THREAD !== undefined
          ? { numThread: parseInteger(env.MUSE_OLLAMA_NUM_THREAD, 0) }
          : {}),
        ...(env.MUSE_OLLAMA_NUM_GPU !== undefined
          ? { numGpu: parseNonNegativeInteger(env.MUSE_OLLAMA_NUM_GPU, -1) }
          : {}),
        // Opt-in /api/show context-window probe: when on, clamps num_ctx down to
        // the model's real window so an over-large MUSE_OLLAMA_NUM_CTX can't
        // cause silent prompt truncation. Off by default (byte-identical wire).
        ...(parseBoolean(env.MUSE_OLLAMA_PROBE_CONTEXT, false)
          ? { probeContextWindow: true }
          : {})
      });
    case "openai":
      return new OpenAIProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENAI_API_KEY),
        baseUrl,
        defaultModel,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
        models
      });
    case "openrouter":
      return new OpenRouterProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENROUTER_API_KEY),
        appName: parseOptionalString(env.MUSE_APP_NAME) ?? "Muse",
        baseUrl,
        defaultModel,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
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
          ...(extraHeaders ? { headers: extraHeaders } : {}),
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
        ...(extraHeaders ? { headers: extraHeaders } : {}),
        id: providerId,
        models
      });
  }
}
