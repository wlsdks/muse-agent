import { evaluateLocalOnlyPosture, LOCAL_FIRST_DEFAULT_MODEL, parseBoolean, resolveDefaultModel } from "@muse/autoconfigure";

/**
 * Which outbound messengers are wired (Telegram/Discord/Slack/LINE), by their
 * provider tokens. Messaging is opt-in, so none configured is ok — this just
 * makes the wired set visible (e.g. why `muse messaging send` has no target).
 */
export function messagingConfigCheck(env: Record<string, string | undefined>): { readonly detail: string; readonly status: "ok" } {
  const set = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;
  const providers = [
    ["telegram", env.MUSE_TELEGRAM_BOT_TOKEN],
    ["discord", env.MUSE_DISCORD_BOT_TOKEN],
    ["slack", env.MUSE_SLACK_BOT_TOKEN],
    ["line", env.MUSE_LINE_CHANNEL_ACCESS_TOKEN]
  ].filter(([, token]) => set(token)).map(([name]) => name);
  return providers.length === 0
    ? { detail: "no messaging provider configured (opt-in — set MUSE_{TELEGRAM,DISCORD,SLACK}_BOT_TOKEN / MUSE_LINE_CHANNEL_ACCESS_TOKEN to enable)", status: "ok" }
    : { detail: `${providers.length.toString()} messenger(s) wired: ${providers.join(", ")}`, status: "ok" };
}

/**
 * Whether the notes RAG index is actually searchable: present + fresh. A
 * pulled embed model isn't enough — recall / ask / `today --connect` all return
 * nothing if the index was never built or has gone stale since notes changed.
 */
export function notesIndexHealth(state: { readonly exists: boolean; readonly stale: boolean }): { readonly detail: string; readonly status: "ok" | "warn" } {
  if (!state.exists) {
    return { detail: "no notes index yet — run `muse notes reindex` so recall / ask / `today --connect` can find your notes", status: "warn" };
  }
  if (state.stale) {
    return { detail: "notes index is stale (notes changed since last build) — run `muse notes reindex` to refresh", status: "warn" };
  }
  return { detail: "notes index present and fresh — recall / ask are searchable", status: "ok" };
}

/**
 * Whether captured past sessions are searchable (recall episodes / `today
 * --connect`). No episodes yet is fine; episodes present but un- or
 * under-indexed means the second brain can't reach prior conversations.
 */
export function episodeIndexHealth(state: { readonly episodeCount: number; readonly indexedCount: number }): { readonly detail: string; readonly status: "ok" | "warn" } {
  if (state.episodeCount === 0) {
    return { detail: "no past sessions captured yet — episodic memory builds up as you use the REPL", status: "ok" };
  }
  if (state.indexedCount === 0) {
    return { detail: `${state.episodeCount.toString()} past session(s) not indexed — run \`muse episode reindex\` so recall / \`today --connect\` can reach them`, status: "warn" };
  }
  if (state.indexedCount < state.episodeCount) {
    return { detail: `episode index lags (${state.indexedCount.toString()}/${state.episodeCount.toString()} indexed) — run \`muse episode reindex\` to catch up`, status: "warn" };
  }
  return { detail: `${state.indexedCount.toString()} past session(s) indexed — searchable via recall / \`today --connect\``, status: "ok" };
}

export interface LocalCheck {
  readonly name: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

/**
 * Report the model the runtime will ACTUALLY use, mirroring `resolveDefaultModel`.
 * Under local-only (the default) the runtime runs the local model and IGNORES any
 * ambient cloud key — so a box that happens to carry a `GEMINI_API_KEY` must NOT
 * be told "model env: inferred from GEMINI_API_KEY" (which makes a privacy-bound
 * user think their data goes to Gemini, contradicting the very guarantee
 * local-only provides). The cloud-credential inference is reported ONLY under an
 * explicit `MUSE_LOCAL_ONLY=false`, exactly as the router resolves it.
 */
export function modelEnvCheck(env: Record<string, string | undefined>): LocalCheck {
  const explicitModel = (env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL)?.trim();
  if (explicitModel && explicitModel.length > 0) {
    return { detail: explicitModel, name: "model env", status: "ok" };
  }
  if (parseBoolean(env.MUSE_LOCAL_ONLY, true)) {
    return {
      detail: `${resolveDefaultModel(env) ?? LOCAL_FIRST_DEFAULT_MODEL} (local-only default — ambient cloud keys ignored)`,
      name: "model env",
      status: "ok"
    };
  }
  const anyKey = [
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY", "OLLAMA_BASE_URL"
  ].find((k) => (env[k] ?? "").trim().length > 0);
  return anyKey
    ? { detail: `inferred from ${anyKey} (MUSE_LOCAL_ONLY=false)`, name: "model env", status: "warn" }
    : { detail: "no MUSE_MODEL / provider key — chat/ask/brief will fail", name: "model env", status: "fail" };
}

/**
 * Report the local-only / no-cloud-egress posture as a doctor check.
 * Delegates to the canonical `evaluateLocalOnlyPosture` so `muse doctor`
 * and `muse setup status` can never disagree about the guarantee.
 */
export function localOnlyCheck(env: Record<string, string | undefined>): LocalCheck {
  const posture = evaluateLocalOnlyPosture(env);
  return { detail: posture.detail, name: "local-only", status: posture.status };
}
