import { evaluateLocalOnlyPosture, LOCAL_FIRST_DEFAULT_MODEL, parseBoolean, resolveDefaultModel } from "@muse/autoconfigure";
import type { DevFixableWeakness } from "@muse/mcp";
import { promises as fs } from "node:fs";
import { DEFAULT_EMBED_MODEL } from "./commands-notes-rag.js";

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

/**
 * Report whether background self-learning (B1) is actually running — the
 * verifiable-autonomy check (Slice 7). Pure of IO so it's directly testable;
 * the caller resolves `enabled` / `paused` / `installed`.
 */
export function selfLearningCheck(state: {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly installed: boolean;
}): LocalCheck {
  const name = "self-learning";
  if (state.paused) {
    return { detail: "PAUSED — run `muse playbook resume` to let Muse learn again", name, status: "warn" };
  }
  if (!state.enabled) {
    return { detail: "OFF (default) — set MUSE_IDLE_LEARNING_ENABLED=true to let Muse learn from corrections while idle", name, status: "ok" };
  }
  if (!state.installed) {
    return { detail: "ON this session, but the daemon isn't installed — run `muse daemon --install` so it keeps learning across reboots", name, status: "warn" };
  }
  return { detail: "ON, will run while idle (daemon installed)", name, status: "ok" };
}

/**
 * Surface the dev-fixable weakness fuel as an INFORMATIONAL doctor line (status
 * "ok" — a recurring agent bug is self-knowledge, not a doctor health failure,
 * so it never flips `worst` to warn). Returns undefined when there's nothing to
 * surface, so plain `muse doctor` stays quiet until real fuel accrues. Pure.
 */
export function weaknessFuelCheck(devFixable: readonly DevFixableWeakness[]): LocalCheck | undefined {
  const top = devFixable[0];
  if (!top) {
    return undefined;
  }
  const more = devFixable.length > 1 ? ` (+${(devFixable.length - 1).toString()} more)` : "";
  return {
    detail: `${devFixable.length.toString()} recurring agent bug${devFixable.length === 1 ? "" : "s"} — top: ${top.topic} (${top.axis} ${top.count.toString()}×)${more}. See \`muse doctor --weaknesses\`.`,
    name: "weakness ledger",
    status: "ok"
  };
}

export interface OllamaPerfEnv {
  readonly flashAttention?: string | undefined;
  readonly kvCacheType?: string | undefined;
}

/**
 * Inference-performance posture of the OLLAMA SERVER (not this process):
 * flash attention + a quantized KV cache roughly halve KV memory, which on a
 * 12B with Muse's long grounded prompts means faster long-context turns and
 * more usable num_ctx on the same RAM. Advisory — warn, never fail.
 */
export function ollamaPerfPostureCheck(values: OllamaPerfEnv): LocalCheck {
  const flashOn = values.flashAttention === "1" || values.flashAttention?.toLowerCase() === "true";
  const kv = values.kvCacheType?.toLowerCase();
  const kvQuantized = kv === "q8_0" || kv === "q4_0";
  if (flashOn && kvQuantized) {
    return { detail: `flash attention on, KV cache ${kv ?? ""} — long-context turns run lighter`, name: "ollama-perf", status: "ok" };
  }
  const missing = [
    ...(flashOn ? [] : ["OLLAMA_FLASH_ATTENTION=1"]),
    ...(kvQuantized ? [] : ["OLLAMA_KV_CACHE_TYPE=q8_0"])
  ];
  return {
    detail: `set ${missing.join(" + ")} on the Ollama server (macOS app: \`launchctl setenv NAME VALUE\` then restart Ollama) — ~halves KV memory for faster long-context turns`,
    name: "ollama-perf",
    status: "warn"
  };
}

/**
 * Resolve the Ollama SERVER's perf env: this process's env first (covers
 * `ollama serve` from the same shell), then macOS launchd (covers Ollama.app,
 * which inherits `launchctl setenv`). Fail-soft — unreadable means unset.
 */
export async function readOllamaPerfEnv(env: Record<string, string | undefined>): Promise<OllamaPerfEnv> {
  const fromLaunchctl = async (name: string): Promise<string | undefined> => {
    if (process.platform !== "darwin") return undefined;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("launchctl", ["getenv", name]);
      const value = stdout.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    flashAttention: env.OLLAMA_FLASH_ATTENTION ?? await fromLaunchctl("OLLAMA_FLASH_ATTENTION"),
    kvCacheType: env.OLLAMA_KV_CACHE_TYPE ?? await fromLaunchctl("OLLAMA_KV_CACHE_TYPE")
  };
}

/**
 * Pure parser pulled out for direct testing. Returns
 * the recorded embed model name (or the documented default,
 * `nomic-embed-text`, when the file exists but doesn't carry one)
 * when notes RAG is in use on this host; `undefined` when no
 * index has ever been written.
 *
 * `rawJson` is the literal file body, or `undefined` to mean
 * "ENOENT". Malformed JSON / missing-field cases fall through to
 * the documented default — a noisy probe is better than a silent
 * gap when the user has clearly opted into RAG.
 */
export function parseNotesIndexEmbedModel(rawJson: string | undefined): string | undefined {
  if (rawJson === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return DEFAULT_EMBED_MODEL;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_EMBED_MODEL;
  const candidate = (parsed as { model?: unknown }).model;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return DEFAULT_EMBED_MODEL;
}

export async function readNotesIndexEmbedModel(path: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return parseNotesIndexEmbedModel(raw);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Unreadable index (permissions?) — flag the probe instead of
    // silently dropping.
    return parseNotesIndexEmbedModel("");
  }
}

/**
 * Verdict for the "ollama embed model" doctor check. `hasIndex`
 * distinguishes "an index records this model" from "no index yet,
 * checking the default" so the message is actionable in both
 * cases. `pulledSizeBytes` is the matched tag size, or undefined
 * when the model isn't pulled. Pure so it tests directly.
 */

export function embedModelCheck(
  embedModel: string,
  hasIndex: boolean,
  pulledSizeBytes: number | undefined
): { readonly detail: string; readonly status: "ok" | "warn" } {
  if (pulledSizeBytes !== undefined) {
    return {
      detail: hasIndex
        ? `${embedModel} pulled (${formatBytes(pulledSizeBytes)}) — RAG over ~/notes works`
        : `${embedModel} pulled (${formatBytes(pulledSizeBytes)}) — notes RAG ready once you run \`muse notes reindex\``,
      status: "ok"
    };
  }
  return {
    detail: hasIndex
      ? `${embedModel} NOT pulled — \`ollama pull ${embedModel}\` (notes RAG will degrade on next search)`
      : `${embedModel} NOT pulled — \`ollama pull ${embedModel}\` (notes RAG / \`muse ask\` unavailable until then)`,
    status: "warn"
  };
}

/** GB / MB / kB formatter for doctor's model-pulled detail line. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "size unknown";
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} kB`;
  return `${bytes.toString()} B`;
}
