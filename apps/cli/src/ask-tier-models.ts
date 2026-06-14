import { classifyTier, type ModelTier } from "@muse/multi-agent";

export interface AskTierModels {
  readonly fast: string;
  readonly heavy: string;
}

// Tier models come from env (parallel to MUSE_MODEL);
// either unset falls back to the configured default model, so --tiered
// with no tier env still answers (on the default for both tiers).
export function resolveAskTierModels(defaultModel: string, env: NodeJS.ProcessEnv): AskTierModels {
  const fast = env.MUSE_FAST_MODEL?.trim();
  const heavy = env.MUSE_HEAVY_MODEL?.trim();
  return {
    fast: fast && fast.length > 0 ? fast : defaultModel,
    heavy: heavy && heavy.length > 0 ? heavy : defaultModel
  };
}

export function routeAskTierModel(
  query: string,
  defaultModel: string,
  env: NodeJS.ProcessEnv
): { readonly model: string; readonly tier: ModelTier } {
  const tier = classifyTier(query);
  const models = resolveAskTierModels(defaultModel, env);
  return { model: tier === "fast" ? models.fast : models.heavy, tier };
}
