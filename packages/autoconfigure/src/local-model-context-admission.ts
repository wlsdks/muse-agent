import { estimateModelRequestTokens, ModelRequestEstimateError } from "@muse/memory";
import {
  awaitModelContextWindow,
  isModelContextWindowCancelledError,
  ModelContextBudgetError,
  type ModelContextWindowResolution,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest
} from "@muse/model";

export { ModelContextBudgetError as LocalModelContextAdmissionError } from "@muse/model";

export interface LocalModelContextAdmissionOptions {
  readonly maxContextWindowTokens: number;
  readonly outputReserveTokens: number;
}

export interface LocalModelContextAdmissionSnapshot {
  readonly enabled: true;
  readonly admitted: number;
  readonly rejected: number;
  readonly stateFailures: number;
  readonly lastEstimatedInputTokens: number;
  readonly lastProviderWindowTokens: number | null;
  readonly lastAdmissionWindowTokens: number;
  readonly lastOutputReserveTokens: number;
  readonly maxObservedUtilizationPermille: number;
}

export interface LocalModelContextAdmissionProviders {
  readonly foreground: ModelProvider;
  readonly background: ModelProvider;
  readonly snapshot: () => LocalModelContextAdmissionSnapshot;
}

type Env = Readonly<Record<string, string | undefined>>;

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim();
  if (!value || !/^(0|[1-9]\d*)$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function resolveLocalModelContextAdmissionOptions(env: Env): LocalModelContextAdmissionOptions {
  return {
    maxContextWindowTokens: boundedInteger(env.MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS, 128_000, 4_096, 2_000_000),
    outputReserveTokens: boundedInteger(env.MUSE_LLM_MAX_OUTPUT_TOKENS, 4_096, 1, 131_072)
  };
}

export function resolveOllamaContextWindowTokens(env: Env): number {
  return boundedInteger(env.MUSE_OLLAMA_NUM_CTX, 32_768, 256, 2_000_000);
}

/** Canonical valid owner overrides that may cross a resident process boundary. */
export function localModelContextAdmissionEnvironment(env: Env): Readonly<Record<string, string>> {
  const projected: Record<string, string> = {};
  const fields = [
    ["MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS", 4_096, 2_000_000],
    ["MUSE_LLM_MAX_OUTPUT_TOKENS", 1, 131_072],
    ["MUSE_LLM_WORKING_BUDGET_TOKENS", 0, 2_000_000],
    ["MUSE_OLLAMA_NUM_CTX", 256, 2_000_000]
  ] as const;
  for (const [name, min, max] of fields) {
    const raw = env[name]?.trim();
    if (!raw || !/^(0|[1-9]\d*)$/u.test(raw)) continue;
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) projected[name] = String(parsed);
  }
  const probe = env.MUSE_OLLAMA_PROBE_CONTEXT?.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(probe ?? "")) projected.MUSE_OLLAMA_PROBE_CONTEXT = "true";
  else if (["false", "0", "no", "off"].includes(probe ?? "")) projected.MUSE_OLLAMA_PROBE_CONTEXT = "false";
  return projected;
}

const projectionMetadata = new WeakMap<ModelProvider, { readonly snapshot: () => LocalModelContextAdmissionSnapshot }>();

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function validWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 256 && value <= 2_000_000;
}

function validOwnerCap(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 4_096 && value <= 2_000_000;
}

function validOutputReserve(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 131_072;
}

function validatedResolution(value: ModelContextWindowResolution | undefined): ModelContextWindowResolution | undefined {
  if (value === undefined) return undefined;
  if (
    Object.keys(value).sort().join(",") !== "provenance,providerWindowTokens"
    || !validWindow(value.providerWindowTokens)
    || (value.provenance !== "configured" && value.provenance !== "probed")
  ) throw new ModelRequestEstimateError();
  return value;
}

export function createLocalModelContextAdmissionProviders(
  foregroundProvider: ModelProvider,
  backgroundProvider: ModelProvider,
  options: LocalModelContextAdmissionOptions
): LocalModelContextAdmissionProviders {
  if (foregroundProvider.id !== backgroundProvider.id) {
    throw new Error("local model context admission providers must have matching ids");
  }
  const existingForeground = projectionMetadata.get(foregroundProvider);
  const existingBackground = projectionMetadata.get(backgroundProvider);
  if (existingForeground || existingBackground) {
    if (!existingForeground || !existingBackground || existingForeground.snapshot !== existingBackground.snapshot) {
      throw new Error("local model context admission projection mismatch");
    }
    return { background: backgroundProvider, foreground: foregroundProvider, snapshot: existingForeground.snapshot };
  }
  if (!validOwnerCap(options.maxContextWindowTokens) || !validOutputReserve(options.outputReserveTokens)) {
    throw new Error("invalid local model context admission options");
  }

  let admitted = 0;
  let rejected = 0;
  let stateFailures = 0;
  let lastEstimatedInputTokens = 0;
  let lastProviderWindowTokens: number | null = null;
  let lastAdmissionWindowTokens = 0;
  let lastOutputReserveTokens = 0;
  let maxObservedUtilizationPermille = 0;
  const snapshot = (): LocalModelContextAdmissionSnapshot => ({
    enabled: true,
    admitted,
    rejected,
    stateFailures,
    lastEstimatedInputTokens,
    lastProviderWindowTokens,
    lastAdmissionWindowTokens,
    lastOutputReserveTokens,
    maxObservedUtilizationPermille
  });

  const admit = async (provider: ModelProvider, request: ModelRequest): Promise<void> => {
    let resolution: ModelContextWindowResolution | undefined;
    try {
      resolution = validatedResolution(await awaitModelContextWindow(provider, request.model, request.signal));
    } catch (error) {
      if (isModelContextWindowCancelledError(error)) throw error;
      stateFailures = increment(stateFailures);
      throw new ModelContextBudgetError(provider.id, "STATE_UNAVAILABLE");
    }
    try {
      const providerWindowTokens = resolution?.providerWindowTokens;
      const admissionWindowTokens = Math.min(options.maxContextWindowTokens, providerWindowTokens ?? options.maxContextWindowTokens);
      const outputReserveTokens = validOutputReserve(request.maxOutputTokens) ? request.maxOutputTokens : options.outputReserveTokens;
      const estimate = estimateModelRequestTokens(request);
      const total = saturatingAdd(estimate.estimatedInputTokens, outputReserveTokens);
      lastEstimatedInputTokens = estimate.estimatedInputTokens;
      lastProviderWindowTokens = providerWindowTokens ?? null;
      lastAdmissionWindowTokens = admissionWindowTokens;
      lastOutputReserveTokens = outputReserveTokens;
      maxObservedUtilizationPermille = Math.max(
        maxObservedUtilizationPermille,
        Math.min(Number.MAX_SAFE_INTEGER, Math.floor(total * 1_000 / admissionWindowTokens))
      );
      if (total > admissionWindowTokens) {
        rejected = increment(rejected);
        throw new ModelContextBudgetError(provider.id, "CONTEXT_BUDGET_EXCEEDED");
      }
      admitted = increment(admitted);
    } catch (error) {
      if (error instanceof ModelContextBudgetError) throw error;
      stateFailures = increment(stateFailures);
      throw new ModelContextBudgetError(provider.id, "STATE_UNAVAILABLE");
    }
  };

  const project = (provider: ModelProvider): ModelProvider => {
    const projected: ModelProvider = {
      id: provider.id,
      listModels: () => provider.listModels(),
      generate: async (request) => {
        await admit(provider, request);
        return provider.generate(request);
      },
      stream: (request) => (async function* (): AsyncIterable<ModelEvent> {
        await admit(provider, request);
        yield* provider.stream(request);
      })(),
      ...(provider.resolveContextWindow
        ? { resolveContextWindow: (model: string) => provider.resolveContextWindow!(model) }
        : {})
    };
    projectionMetadata.set(projected, { snapshot });
    return projected;
  };

  return { background: project(backgroundProvider), foreground: project(foregroundProvider), snapshot };
}
