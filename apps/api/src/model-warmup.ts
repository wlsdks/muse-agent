import { parseBooleanFromEnv, withBestEffort } from "@muse/shared";

import type { ModelProvider } from "@muse/model";

export interface ModelWarmupOptions {
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
}

/**
 * First-request cold-start is the worst latency a user feels from an always-on
 * companion: `keep_alive` (the Ollama adapter default) only keeps the model
 * resident BETWEEN requests, so the FIRST request after a server start still
 * pays the full model load (tens of seconds for a 12B). When
 * `MUSE_WARMUP_MODEL` is set, fire a tiny generate at startup so the model is
 * already resident when the first user request arrives.
 *
 * Opt-in (default off ⇒ startup is byte-identical) and FAIL-SOFT: the warmup is
 * fire-and-forget and a failure (Ollama not up yet, model not pulled) must
 * NEVER affect server start. The `.catch` swallows both sync throws and async
 * rejections. Local-only by construction — it calls the configured provider,
 * which under the default posture is the local model.
 */
export function warmUpModelIfConfigured(
  env: Record<string, string | undefined>,
  options: ModelWarmupOptions
): void {
  const enabled = parseBooleanFromEnv(env.MUSE_WARMUP_MODEL, false);
  if (!enabled || !options.modelProvider || !options.defaultModel) {
    return;
  }
  const provider = options.modelProvider;
  const model = options.defaultModel;
  void withBestEffort(provider.generate({
    messages: [{ content: "ok", role: "user" }],
    maxOutputTokens: 1,
    model
  }), undefined);
}
