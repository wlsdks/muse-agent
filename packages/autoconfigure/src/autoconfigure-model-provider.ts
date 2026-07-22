import {
  AnthropicProvider,
  canonicalizeLocalOnlyModelBaseUrl,
  classifyProviderLocality,
  CodexCliProvider,
  CODEX_DEFAULT_MODEL_ID,
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

import { readFileSync } from "node:fs";

import { parseBoolean, parseCsv, parseHeaderMap, parseInteger, parseNonNegativeFloat, parseNonNegativeInteger, parseOptionalString } from "./env-parsers.js";
import { resolveMuseCliConfigFilePath } from "./provider-paths.js";
import {
  createCrossProcessModelExecutionLeaseProviders,
  resolveCrossProcessModelExecutionLeaseOptions
} from "./cross-process-model-execution-lease.js";
import {
  createLocalModelContextAdmissionProviders,
  resolveLocalModelContextAdmissionOptions,
  resolveOllamaContextWindowTokens
} from "./local-model-context-admission.js";

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

export type AuxiliaryTask = "compaction" | "vision" | "rewrite" | "judge" | "embedding-rescue";

export interface AuxiliaryModelResolution {
  readonly model: string;
  readonly source: "task-env" | "legacy-env" | "session";
  readonly route: "local" | "cloud";
  readonly keptLocalForPrivacy: boolean;
}

const LEGACY_AUXILIARY_ENV_KEY: Record<AuxiliaryTask, keyof MuseEnvironment | undefined> = {
  compaction: undefined,
  "embedding-rescue": "MUSE_RECALL_EMBED_MODEL",
  judge: undefined,
  rewrite: undefined,
  vision: "MUSE_VISION_MODEL"
};

function auxiliaryTaskEnvKey(task: AuxiliaryTask): string {
  return `MUSE_AUX_${task.toUpperCase().replace(/-/gu, "_")}_MODEL`;
}

function classifyModelRoute(model: string): "local" | "cloud" {
  const providerId = parseModelName(model).providerId ?? providerIdFromPrefix(model) ?? "openai-compatible";
  return classifyProviderLocality(providerId, undefined);
}

/**
 * One resolver for every auxiliary (non-chat) task Muse's runtime spins up a
 * model for — compaction, vision, rewrite, judge, embedding-rescue — instead
 * of each task growing its own ad-hoc env knob. Precedence, first non-empty
 * wins:
 *
 *  1. The generalized per-task knob `MUSE_AUX_<TASK>_MODEL`: `MUSE_AUX_COMPACTION_MODEL`,
 *     `MUSE_AUX_VISION_MODEL`, `MUSE_AUX_REWRITE_MODEL`, `MUSE_AUX_JUDGE_MODEL`,
 *     `MUSE_AUX_EMBEDDING_RESCUE_MODEL`.
 *  2. The task's LEGACY knob, where one exists (`MUSE_VISION_MODEL`,
 *     `MUSE_RECALL_EMBED_MODEL`) — kept so an existing deployment's env
 *     doesn't silently stop working when this resolver lands. Compaction,
 *     rewrite, and judge never had a dedicated model knob, so they fall
 *     straight through to the session model.
 *  3. The session model.
 *
 * LOCAL-FIRST invariant (fail-close): an auxiliary knob can select a model
 * for a task the operator doesn't think of as "the chat model", so it is an
 * easy place to accidentally leak a personal-context task to the cloud
 * (e.g. `MUSE_AUX_VISION_MODEL=gemini/...` on a photo of a private document).
 * When the resolved model routes to "cloud" AND the caller says this task is
 * personal-context (`isPersonalContext: true`) OR the whole runtime is under
 * `MUSE_LOCAL_ONLY`, the override is REFUSED and the session model is used
 * instead (`keptLocalForPrivacy: true`) — an aux knob can never escalate a
 * personal or local-only task to the cloud, only a deliberate explicit
 * session/chat model choice can.
 */
export function resolveAuxiliaryModel(params: {
  readonly task: AuxiliaryTask;
  readonly env: MuseEnvironment;
  readonly sessionModel: string;
  readonly isPersonalContext?: boolean;
}): AuxiliaryModelResolution {
  const { task, env, sessionModel, isPersonalContext } = params;

  const taskEnvValue = parseOptionalString(env[auxiliaryTaskEnvKey(task)]);
  const legacyEnvKey = LEGACY_AUXILIARY_ENV_KEY[task];
  const legacyEnvValue = legacyEnvKey ? parseOptionalString(env[legacyEnvKey]) : undefined;

  const chosen = taskEnvValue ?? legacyEnvValue ?? sessionModel;
  const source: AuxiliaryModelResolution["source"] = taskEnvValue !== undefined
    ? "task-env"
    : legacyEnvValue !== undefined
      ? "legacy-env"
      : "session";

  const route = classifyModelRoute(chosen);
  const mustStayLocal = isPersonalContext === true || parseBoolean(env.MUSE_LOCAL_ONLY, false);
  if (route === "cloud" && mustStayLocal) {
    return {
      keptLocalForPrivacy: true,
      model: sessionModel,
      route: classifyModelRoute(sessionModel),
      source: "session"
    };
  }

  return { keptLocalForPrivacy: false, model: chosen, route, source };
}

export interface ModelFallbackChainResolution {
  readonly chain: readonly string[];
  readonly dropped: readonly { readonly model: string; readonly reason: string }[];
}

/**
 * Turn `MUSE_MODEL_FALLBACKS` (a comma-separated model list) into an ordered,
 * privacy-gated fallback chain — the explicit opt-in Muse's "no hidden
 * retries" principle requires: a fallback happens ONLY when the operator
 * names it, never as an implicit provider-hop the runtime invents on its own.
 *
 * Unset (or blank/whitespace-only) → `{ chain: [], dropped: [] }`, byte-identical
 * to today's no-fallback behavior — no `ModelFallbackStrategy` is constructed
 * from an empty chain.
 *
 * Each configured model is re-gated the same way `resolveAuxiliaryModel` gates
 * an override: a fallback is exactly the kind of secondary path that could
 * quietly become a cloud-egress hole, so a cloud-routed entry is DROPPED
 * (never silently promoted to the top of the chain, never thrown) when
 * `MUSE_LOCAL_ONLY` is set or the caller marks this request personal-context —
 * order among the surviving entries is preserved.
 */
export function resolveModelFallbackChain(params: {
  readonly env: MuseEnvironment;
  readonly isPersonalContext?: boolean;
}): ModelFallbackChainResolution {
  const { env, isPersonalContext } = params;
  const raw = parseOptionalString(env.MUSE_MODEL_FALLBACKS);
  if (!raw) {
    return { chain: [], dropped: [] };
  }

  const models = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const localOnly = parseBoolean(env.MUSE_LOCAL_ONLY, false);
  const chain: string[] = [];
  const dropped: { model: string; reason: string }[] = [];

  for (const model of models) {
    const route = classifyModelRoute(model);
    const isCloud = route === "cloud";
    if (isCloud && localOnly) {
      dropped.push({ model, reason: "MUSE_LOCAL_ONLY forbids cloud egress" });
      continue;
    }
    if (isCloud && isPersonalContext === true) {
      dropped.push({ model, reason: "personal request stays local" });
      continue;
    }
    chain.push(model);
  }

  return { chain, dropped };
}

/**
 * Resolve the default model identifier the runtime should use.
 *
 * Priority: explicit `MUSE_MODEL` (or `MUSE_DEFAULT_MODEL`) → local-only forced
 * local → the user's saved choice in `~/.config/muse/config.json` → a model
 * inferred from an ambient cloud credential → the local fallback.
 *
 * The config-file rung exists because a STALE ambient key must not beat an
 * explicit user choice: a dead `GEMINI_API_KEY` in the shell hijacked every
 * bare-assembly surface (`muse ask`/`brief`/jobs) into a 400-erroring cloud
 * provider while `muse config set defaultModel ollama/gemma4:12b` sat ignored
 * (recurred three times before this fix, 2026-07-17). Local-only still wins
 * over a cloud model saved in config — fail-close posture is not user-config
 * overridable.
 */
export function resolveDefaultModel(env: MuseEnvironment): string | undefined {
  const explicit = parseOptionalString(env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL);
  if (explicit) {
    return explicit;
  }
  if (parseBoolean(env.MUSE_LOCAL_ONLY, false)) {
    return LOCAL_FIRST_DEFAULT_MODEL;
  }
  const configured = readConfiguredDefaultModel(env);
  if (configured) {
    return configured;
  }
  // Cloud is allowed by default: prefer a model inferred from an ambient cloud
  // credential, but ALWAYS fall back to the local default so a fresh box with no
  // cloud key (and no OLLAMA_BASE_URL) still boots on gemma4:12b — never a
  // no-default-model dead end.
  return inferDefaultModelFromCredentials(env) ?? LOCAL_FIRST_DEFAULT_MODEL;
}

// Cache keyed by resolved config path so hot paths don't re-stat the file on
// every assembly build; a different MUSE_CLI_CONFIG_FILE/HOME (tests) re-reads.
const configuredModelCache = new Map<string, string | undefined>();

/** Test seam: drop the config-file cache (a long-lived process re-reads on next resolve). */
export function clearConfiguredDefaultModelCache(): void {
  configuredModelCache.clear();
}

function readConfiguredDefaultModel(env: MuseEnvironment): string | undefined {
  let file: string;
  try {
    file = resolveMuseCliConfigFilePath(env);
  } catch {
    return undefined;
  }
  if (configuredModelCache.has(file)) {
    return configuredModelCache.get(file);
  }
  let value: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { defaultModel?: unknown };
    value = typeof parsed.defaultModel === "string" && parsed.defaultModel.trim().length > 0
      ? parsed.defaultModel.trim()
      : undefined;
  } catch {
    value = undefined;
  }
  configuredModelCache.set(file, value);
  return value;
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

interface ModelProviderIdentity {
  readonly baseUrl: string | undefined;
  readonly defaultModel: string;
  readonly effectiveBaseUrl: string | undefined;
  readonly providerId: string;
}

function resolveModelProviderIdentity(
  env: MuseEnvironment,
  modelOverride?: string
): ModelProviderIdentity | undefined {
  const defaultModel = modelOverride ?? resolveDefaultModel(env);
  if (!defaultModel) return undefined;

  // `modelOverride` builds a provider for a SPECIFIC model string rather than
  // the session's resolved default (privacy-tiered routing: constructing the
  // cloud provider for a context-free turn). In that case the session's own
  // `MUSE_MODEL_BASE_URL` / `MUSE_MODEL_PROVIDER_ID` pins (e.g. the local
  // Ollama base URL, or `providerId: "ollama"` set for the session's LOCAL
  // model) must NOT leak into the override's provider resolution — the
  // override model's own prefix (`gemini/…`, `anthropic/…`) decides its
  // provider instead.
  const baseUrl = modelOverride ? undefined : parseOptionalString(env.MUSE_MODEL_BASE_URL);
  const explicitProviderId = modelOverride ? undefined : parseOptionalString(env.MUSE_MODEL_PROVIDER_ID);
  const providerId = explicitProviderId
    ?? (baseUrl ? "openai-compatible" : parseModelName(defaultModel).providerId)
    ?? (baseUrl ? "openai-compatible" : providerIdFromPrefix(defaultModel))
    ?? "openai-compatible";
  const effectiveBaseUrl = providerId === "ollama"
    ? (baseUrl ?? normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL))
    : OPENAI_COMPAT_PRESETS[providerId]
      ? (baseUrl ?? OPENAI_COMPAT_PRESETS[providerId].baseUrl)
      : baseUrl;
  return { baseUrl, defaultModel, effectiveBaseUrl, providerId };
}

export interface ModelProviderResolution {
  readonly locality: "cloud" | "local";
  readonly provider: ModelProvider;
  /** True only for a physical local inference transport, not the in-memory diagnostic provider. */
  readonly requiresLocalExecutionLease: boolean;
}

function createRawModelProvider(env: MuseEnvironment, modelOverride?: string): ModelProvider | undefined {
  const identity = resolveModelProviderIdentity(env, modelOverride);
  if (!identity) return undefined;
  const { baseUrl, defaultModel, effectiveBaseUrl, providerId } = identity;
  const models = parseCsv(env.MUSE_MODEL_LIST) ?? [parseModelName(defaultModel).modelId];
  const extraHeaders = parseHeaderMap(env.MUSE_MODEL_EXTRA_HEADERS);
  const localOnly = parseBoolean(env.MUSE_LOCAL_ONLY, false);
  const transportBaseUrl = localOnly
    ? canonicalizeLocalOnlyModelBaseUrl(providerId, effectiveBaseUrl)
    : effectiveBaseUrl;

  // Local-only / no-cloud-egress: an OPT-IN posture (MUSE_LOCAL_ONLY=true).
  // Canonicalize before classifying and before constructing an adapter, so an
  // accepted localhost spelling cannot later be resolved by the transport.
  if (localOnly) {
    // LM Studio is an OpenAI-compatible server with no implicit Muse endpoint.
    // An unset base stays the existing no-provider outcome instead of inventing
    // a numeric endpoint merely because local-only is enabled.
    if (providerId === "lmstudio" && transportBaseUrl === undefined) {
      return undefined;
    }
    if (classifyProviderLocality(providerId, transportBaseUrl) !== "local") {
      throw new LocalOnlyViolationError(providerId, transportBaseUrl);
    }
  }

  switch (providerId) {
    case "diagnostic":
      return new DiagnosticModelProvider({
        defaultModel,
        models
      });
    case "codex": {
      // Opt-in ChatGPT-subscription delegation via the official codex CLI. NEVER
      // the default — only reached when the effective model is `codex/<model>`
      // (or MUSE_MODEL_PROVIDER_ID=codex). Cloud, so the local-only gate above
      // already refused it under MUSE_LOCAL_ONLY. Muse holds no ChatGPT token —
      // the codex CLI owns auth; this adapter only shells out to it.
      const codexModel = parseModelName(defaultModel).modelId;
      return new CodexCliProvider({
        models,
        ...(codexModel && codexModel !== CODEX_DEFAULT_MODEL_ID ? { model: codexModel } : {})
      });
    }
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
        baseUrl: transportBaseUrl,
        defaultModel,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
        models,
        numCtx: resolveOllamaContextWindowTokens(env),
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
          baseUrl: transportBaseUrl ?? preset.baseUrl,
          defaultModel,
          ...(extraHeaders ? { headers: extraHeaders } : {}),
          id: providerId,
          models
        });
      }
      if (!transportBaseUrl) {
        return undefined;
      }

      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENAI_API_KEY),
        baseUrl: transportBaseUrl,
        defaultModel,
        ...(extraHeaders ? { headers: extraHeaders } : {}),
        id: providerId,
        models
      });
  }
}

/** Resolve the raw adapter plus canonical locality for composition roots. */
export function resolveModelProvider(
  env: MuseEnvironment,
  modelOverride?: string
): ModelProviderResolution | undefined {
  const identity = resolveModelProviderIdentity(env, modelOverride);
  if (!identity) return undefined;
  const provider = createRawModelProvider(env, modelOverride);
  if (!provider) return undefined;
  const locality = classifyProviderLocality(identity.providerId, identity.effectiveBaseUrl);
  return {
    locality,
    provider,
    requiresLocalExecutionLease: identity.providerId !== "diagnostic" && locality === "local"
  };
}

/**
 * Public provider factory. Local adapters are foreground projections so direct
 * callers cannot bypass the cross-process admission boundary.
 */
export function createModelProvider(env: MuseEnvironment, modelOverride?: string): ModelProvider | undefined {
  const resolution = resolveModelProvider(env, modelOverride);
  if (!resolution) return undefined;
  if (!resolution.requiresLocalExecutionLease) return resolution.provider;
  const crossProcess = createCrossProcessModelExecutionLeaseProviders(
    resolution.provider,
    resolveCrossProcessModelExecutionLeaseOptions(env)
  );
  return createLocalModelContextAdmissionProviders(
    crossProcess.foreground,
    crossProcess.background,
    resolveLocalModelContextAdmissionOptions(env)
  ).foreground;
}

/**
 * Build a `ModelProvider` for an EXPLICIT model string, independent of the
 * caller's own session default — privacy-tiered routing's cloud leg (see
 * `resolvePrivacyRoutedModel` in `@muse/policy`): a context-free turn is
 * routed to `MUSE_CLOUD_MODEL`, which needs its OWN provider instance
 * distinct from the session's (usually local) `modelProvider`. Thin wrapper
 * over `createModelProvider`'s override branch — kept as a named export so
 * call sites read as "build the cloud provider", not
 * "createModelProvider with a mystery second argument". Still runs the
 * `MUSE_LOCAL_ONLY` gate inside `createModelProvider` (throws
 * `LocalOnlyViolationError` for a cloud model under local-only) — a second,
 * defense-in-depth enforcement layer beyond the policy check that decided to
 * route here in the first place.
 */
export function createModelProviderFor(model: string, env: MuseEnvironment): ModelProvider | undefined {
  return createModelProvider(env, model);
}
