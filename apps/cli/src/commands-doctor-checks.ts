import { isCalibratedEmbedder, resolveRecallConfidentAt } from "@muse/agent-core";
import { evaluateLocalOnlyPosture, evaluateWebEgressStatus, LOCAL_FIRST_DEFAULT_MODEL, parseBoolean, resolveDefaultModel, resolveVisionModel } from "@muse/autoconfigure";
import { resolvePlatformCapabilities } from "@muse/shared";
import { DEFAULT_FOCUS_OFF_SHORTCUT, DEFAULT_FOCUS_ON_SHORTCUT } from "@muse/macos";
import type { DevFixableWeakness } from "@muse/stores";
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
 * Whether the two named Focus shortcuts (`mac_system_set` focus_on/focus_off)
 * exist, so "방해금지 켜줘" / "turn on do not disturb" actually toggles. macOS has
 * no Focus CLI, so the toggle runs a user Shortcut carrying Apple's "Set Focus"
 * action; this reports whether those shortcuts are installed. `listOutput`
 * `undefined` means we couldn't enumerate (no Shortcuts access) — a warn, not a
 * fail. Only surfaced when the macOS actuators are enabled.
 */
export function focusShortcutsCheck(
  env: Record<string, string | undefined>,
  listOutput: readonly string[] | undefined
): { readonly detail: string; readonly status: "ok" | "warn" } {
  const on = env.MUSE_FOCUS_ON_SHORTCUT?.trim() || DEFAULT_FOCUS_ON_SHORTCUT;
  const off = env.MUSE_FOCUS_OFF_SHORTCUT?.trim() || DEFAULT_FOCUS_OFF_SHORTCUT;
  if (listOutput === undefined) {
    return { detail: `couldn't list Shortcuts — grant Shortcuts access, then create "${on}" + "${off}" (each with the "Set Focus" action) to enable 방해금지/집중모드 toggling`, status: "warn" };
  }
  const names = new Set(listOutput);
  const missing = [on, off].filter((name) => !names.has(name));
  if (missing.length === 0) {
    return { detail: `both Focus shortcuts present ("${on}", "${off}") — focus_on/focus_off ready`, status: "ok" };
  }
  return {
    detail: `missing ${missing.map((name) => `"${name}"`).join(" + ")} — create in Shortcuts.app with the "Set Focus" action (On/Off), or point MUSE_FOCUS_ON_SHORTCUT / MUSE_FOCUS_OFF_SHORTCUT at existing ones`,
    status: "warn"
  };
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
 * Report which platform-dependent surfaces are active on this OS — the honesty
 * line for a non-mac box: absent integrations are DISABLED by design, not
 * broken. Windows support is proven by CI, not by a live machine — say so.
 */
export function platformPostureCheck(platform: NodeJS.Platform = process.platform): LocalCheck {
  const caps = resolvePlatformCapabilities(platform);
  const integrations = caps.osIntegrations === "macos"
    ? "os-integrations=macos (Notes/Reminders/Contacts mirrors available)"
    : caps.osIntegrations === "windows"
      ? "os-integrations=windows (PowerShell actuators; arm with MUSE_WINDOWS_ACTUATORS=true)"
      : "os-integrations=none (native integrations unavailable on this OS)";
  const provenance = caps.os === "win32" ? " — Windows paths are CI-verified only" : "";
  return {
    detail: `platform=${caps.os}: audio=${caps.audioPlayer ?? "none"}, autostart=${caps.daemonAutostart}, ${integrations}${provenance}`,
    name: "platform posture",
    status: "ok"
  };
}

/**
 * Report which SecretSource readers are available, NEVER a secret value. The
 * resolver reads credentials on demand from the user's existing local vault
 * (env / macOS keychain) and falls back to the legacy per-service store. This
 * only counts configured `MUSE_SECRET_*` env vars + whether keychain is usable
 * on this platform — a boolean posture, like the official-MCP audit line.
 */
export function secretSourcesCheck(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): LocalCheck {
  const envCount = Object.keys(env).filter((k) => k.startsWith("MUSE_SECRET_")).length;
  const sources: string[] = [];
  if (envCount > 0) {
    sources.push(`env (${envCount.toString()} MUSE_SECRET_* set)`);
  }
  if (platform === "darwin") {
    sources.push("keychain (macOS)");
  }
  sources.push("legacy store (fallback)");
  return {
    detail: `secret sources, vault-first: ${sources.join(" → ")} — values read on demand, never cached or sent to the model`,
    name: "secret sources",
    status: "ok"
  };
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
  if (parseBoolean(env.MUSE_LOCAL_ONLY, false)) {
    return {
      detail: `${resolveDefaultModel(env) ?? LOCAL_FIRST_DEFAULT_MODEL} (local-only on — ambient cloud keys ignored)`,
      name: "model env",
      status: "ok"
    };
  }
  const anyKey = [
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY", "OLLAMA_BASE_URL"
  ].find((k) => (env[k] ?? "").trim().length > 0);
  return anyKey
    ? { detail: `inferred from ${anyKey} (cloud allowed — set MUSE_LOCAL_ONLY=true to force local)`, name: "model env", status: "warn" }
    : { detail: `${LOCAL_FIRST_DEFAULT_MODEL} (local default — no cloud key set)`, name: "model env", status: "ok" };
}

/**
 * Report which model the VISION surface (`muse ask --image`, `--auto`) will use,
 * mirroring `resolveVisionModel` so a user can see when the image path runs a
 * dedicated vision model rather than the chat default (and that `MUSE_VISION_MODEL`
 * took effect). Pure — no availability probe here; the runtime fail-soft covers a
 * not-pulled model.
 */
export function visionModelCheck(env: Record<string, string | undefined>): LocalCheck {
  const sessionModel = resolveDefaultModel(env) ?? LOCAL_FIRST_DEFAULT_MODEL;
  const visionModel = resolveVisionModel({ env, sessionModel });
  const detail = visionModel === sessionModel
    ? `${visionModel} (same as chat model)`
    : `${visionModel}${env.MUSE_VISION_MODEL ? " (MUSE_VISION_MODEL)" : " (local vision default)"}`;
  return { detail, name: "vision model", status: "ok" };
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

/** Web-egress master switch (MUSE_WEB_EGRESS) posture — orthogonal to local-only. */
export function webEgressCheck(env: Record<string, string | undefined>): LocalCheck {
  const posture = evaluateWebEgressStatus(env);
  return { detail: posture.detail, name: "web-egress", status: posture.status };
}

/**
 * Report privacy-tiered routing's posture on the chat surface — off by
 * default (every turn local), opt-in cloud leg for context-free turns only,
 * or forced-local by `MUSE_LOCAL_ONLY` (which always wins). Mirrors
 * `resolvePrivacyRoutedModel`'s own precedence (`@muse/policy`) so this line
 * can never disagree with what a chat turn actually does.
 */
export function privacyRoutingCheck(env: Record<string, string | undefined>): LocalCheck {
  const name = "privacy routing";
  if (parseBoolean(env.MUSE_LOCAL_ONLY, false)) {
    return { detail: "forced local — MUSE_LOCAL_ONLY overrides privacy routing; a cloud model is never attempted", name, status: "ok" };
  }
  if (!parseBoolean(env.MUSE_PRIVACY_ROUTING, false)) {
    return { detail: "off — every chat turn stays local (opt in with MUSE_PRIVACY_ROUTING=true + MUSE_CLOUD_MODEL)", name, status: "ok" };
  }
  const cloudModel = env.MUSE_CLOUD_MODEL?.trim();
  if (!cloudModel) {
    return { detail: "on but MUSE_CLOUD_MODEL is not set — every turn still stays local", name, status: "warn" };
  }
  return {
    detail: `on — a context-free turn may route to ${cloudModel}; any personal signal (persona, grounding, PII, possessive marker, remembered fact) keeps it local`,
    name,
    status: "ok"
  };
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

/**
 * Voice-loop setup guidance (STT + TTS) as actionable doctor lines. Voice is
 * opt-in and local-only, so being OFF is never a health FAILURE — the checks
 * stay "ok" and instead carry the exact steps to turn it on. The one warn is a
 * half-configured Piper (`MUSE_VOICE_TTS=piper` but no `MUSE_PIPER_VOICE`),
 * which silently won't register.
 *
 * The STT guidance points at the MULTILINGUAL `ggml-base.bin` (99 languages
 * incl. Korean) — NOT the English-only `.en` build — because Korean is the
 * language the primary user actually speaks. The Korean-TTS guidance names the
 * KSS Piper voice and reproduces its non-commercial license verbatim, since an
 * honest note matters if Muse ever ships commercially.
 */
export function voiceSetupChecks(env: Record<string, string | undefined>): LocalCheck[] {
  const sttChoice = env.MUSE_VOICE_STT?.trim().toLowerCase();
  const ttsChoice = env.MUSE_VOICE_TTS?.trim().toLowerCase();
  const piperVoice = env.MUSE_PIPER_VOICE?.trim();
  const useLocalStt = sttChoice === "whisper-cpp";
  const useLocalTts = ttsChoice === "piper" && !!piperVoice && piperVoice.length > 0;

  const checks: LocalCheck[] = [];

  if (useLocalStt) {
    checks.push({
      detail:
        "local Whisper.cpp ENABLED (MUSE_VOICE_STT=whisper-cpp). Default model ~/.muse/whisper-models/ggml-base.bin is MULTILINGUAL (99 languages incl. Korean; `-l auto` detects the language). MUSE_WHISPER_CPP_MODEL overrides it.",
      name: "voice:stt",
      status: "ok"
    });
  } else {
    checks.push({
      detail:
        "OFF (opt-in). Enable local, Korean-capable speech-to-text: (1) set MUSE_VOICE_STT=whisper-cpp; " +
        "(2) install the binary — `brew install whisper-cpp` (macOS) or build github.com/ggerganov/whisper.cpp; " +
        "(3) download the MULTILINGUAL model — `mkdir -p ~/.muse/whisper-models && curl -L -o ~/.muse/whisper-models/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`. " +
        "Use ggml-base.bin (99 languages incl. Korean), NOT ggml-base.en.bin — the .en build will NOT transcribe Korean.",
      name: "voice:stt",
      status: "ok"
    });
  }

  if (useLocalTts) {
    checks.push({
      detail: `local Piper ENABLED (MUSE_VOICE_TTS=piper, voice ${piperVoice ?? ""}).`,
      name: "voice:tts",
      status: "ok"
    });
  } else if (ttsChoice === "piper") {
    checks.push({
      detail:
        "MUSE_VOICE_TTS=piper is set but MUSE_PIPER_VOICE is empty — Piper will NOT register (no voice model). Point MUSE_PIPER_VOICE at a .onnx voice file to enable local TTS.",
      name: "voice:tts",
      status: "warn"
    });
  } else {
    checks.push({
      detail:
        "OFF (opt-in). Enable local text-to-speech: (1) set MUSE_VOICE_TTS=piper; (2) install the binary — `pipx install piper-tts` or a release from github.com/rhasspy/piper/releases; " +
        "(3) download a voice and set MUSE_PIPER_VOICE to its .onnx path. " +
        "For KOREAN TTS, use the KSS voice: https://huggingface.co/neurlang/piper-onnx-kss-korean — " +
        "LICENSE: CC-BY-NC-SA 4.0 (Attribution-NonCommercial-ShareAlike). Non-commercial only: fine for personal use, but it may NOT be bundled into a commercial product.",
      name: "voice:tts",
      status: "ok"
    });
  }

  return checks;
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
  // A quantized KV cache is INERT without flash attention: Ollama silently
  // falls back to f16 KV (no memory/speed gain) unless OLLAMA_FLASH_ATTENTION=1
  // AND the model's arch supports flash attention. Flag the wasted setting
  // specifically — the generic "set flash" line below hides that q8_0/q4_0 is
  // currently doing nothing. (Ollama FAQ + ollama/ollama#13337 + PR #6279.)
  if (kvQuantized && !flashOn) {
    return {
      detail: `OLLAMA_KV_CACHE_TYPE=${kv ?? ""} is set but INERT without OLLAMA_FLASH_ATTENTION=1 — Ollama silently falls back to f16 KV (no memory gain). Set OLLAMA_FLASH_ATTENTION=1 on the server (needs a flash-attention-capable model) to actually halve KV memory`,
      name: "ollama-perf",
      status: "warn"
    };
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

export interface MuseSpeedEnv {
  readonly numBatch?: string | undefined;
  readonly numCtx?: string | undefined;
  readonly keepAlive?: string | undefined;
  readonly numPredict?: string | undefined;
}

/**
 * Muse-PROCESS speed env posture — distinct from the Ollama SERVER env in
 * `ollamaPerfPostureCheck` (launchctl). These are the per-request knobs Muse
 * maps onto Ollama: `MUSE_OLLAMA_NUM_BATCH` (prompt-eval throughput),
 * `MUSE_OLLAMA_NUM_CTX` (context window), `MUSE_OLLAMA_KEEP_ALIVE` (model
 * warmth), `MUSE_OLLAMA_NUM_PREDICT` (default generation cap for requests
 * without an explicit limit). All optional with safe defaults, so this is
 * advisory (always ok) — its job is to make the shipped levers DISCOVERABLE
 * instead of invisible, with a concrete tuning hint when num_batch is unset.
 */
export function museSpeedEnvCheck(values: MuseSpeedEnv): LocalCheck {
  const set: string[] = [];
  if (values.numBatch?.trim()) set.push(`num_batch=${values.numBatch.trim()}`);
  if (values.numCtx?.trim()) set.push(`num_ctx=${values.numCtx.trim()}`);
  if (values.keepAlive?.trim()) set.push(`keep_alive=${values.keepAlive.trim()}`);
  if (values.numPredict?.trim()) set.push(`num_predict=${values.numPredict.trim()}`);
  const tuned = set.length > 0 ? `tuned ${set.join(", ")}` : "all default";
  const batchHint = values.numBatch?.trim()
    ? ""
    : " — set MUSE_OLLAMA_NUM_BATCH (e.g. 1024) to raise prompt-eval throughput on long prompts";
  return {
    detail: `Muse local-model speed env: ${tuned}${batchHint}`,
    name: "muse-speed-env",
    status: "ok"
  };
}

export function readMuseSpeedEnv(env: Record<string, string | undefined>): MuseSpeedEnv {
  return {
    keepAlive: env.MUSE_OLLAMA_KEEP_ALIVE,
    numBatch: env.MUSE_OLLAMA_NUM_BATCH,
    numCtx: env.MUSE_OLLAMA_NUM_CTX,
    numPredict: env.MUSE_OLLAMA_NUM_PREDICT
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

/**
 * Surface the recall confidence floor's calibration posture — the bar a recall
 * hit must clear to be cited as authoritative (the "I'm not sure" wedge). The bar
 * is EMBEDDER-SPECIFIC; the shipped default v2-moe is calibrated to 0.45, but an
 * unrecognised embedder falls back to the conservative 0.55 and may over-abstain.
 * Makes the grounding floor's calibration legible ("shows its work") rather than
 * an invisible constant. Pure.
 */
export function recallCalibrationCheck(
  embedModel: string,
  env: NodeJS.ProcessEnv = process.env
): { readonly detail: string; readonly status: "ok" | "warn" } {
  const bar = resolveRecallConfidentAt(env, embedModel).toFixed(2);
  const override = Number(env.MUSE_GROUNDING_MIN_COSINE);
  if (Number.isFinite(override) && override > 0 && override <= 1) {
    return { detail: `recall confidence bar ${bar} — set via MUSE_GROUNDING_MIN_COSINE (conformal override from \`muse doctor --calibration\`)`, status: "ok" };
  }
  if (isCalibratedEmbedder(embedModel)) {
    return { detail: `recall confidence bar ${bar} — calibrated for ${embedModel}`, status: "ok" };
  }
  return {
    detail: `recall confidence bar ${bar} — conservative fallback (embedder '${embedModel}' has no calibrated bar, so recall may over-abstain). Tune it with \`muse doctor --calibration\`.`,
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

/**
 * Surface the scheduler pause kill-switch so a deliberately-paused scheduler
 * doesn't read as "broken" (autonomous jobs silently not firing is otherwise
 * confusing). Pure — takes the already-read pause state.
 */
export function schedulerPauseCheck(
  state: { readonly paused: boolean; readonly since?: string }
): { readonly detail: string; readonly status: "ok" | "warn" } {
  return state.paused
    ? { detail: `autonomous scheduled jobs are PAUSED${state.since ? ` (since ${state.since})` : ""} — run \`muse scheduler resume\` to re-enable`, status: "warn" }
    : { detail: "scheduler active — autonomous jobs fire on schedule", status: "ok" };
}

/**
 * Surface FAILED background processes (a dev server / watch build that
 * crashed) so the user notices instead of assuming it's still up. Pure —
 * takes the already-read registry records. A failed one warns; otherwise
 * reports the running count.
 */
export function backgroundProcessCheck(
  records: readonly { readonly id: string; readonly status: string }[]
): { readonly detail: string; readonly status: "ok" | "warn" } {
  const failed = records.filter((record) => record.status === "failed");
  if (failed.length > 0) {
    return { detail: `${failed.length.toString()} background process(es) failed (e.g. ${failed[0]!.id}) — see \`muse bg logs <id>\``, status: "warn" };
  }
  const running = records.filter((record) => record.status === "running").length;
  return { detail: running > 0 ? `${running.toString()} background process(es) running` : "no background processes", status: "ok" };
}

/**
 * Known cloud-sync folder fragments. Muse's local file stores rely on an
 * O_EXCL cross-process lock (`atomic-file-store.ts`) that a multi-device
 * sync client (iCloud/Dropbox/Google Drive/OneDrive) can race — two devices
 * syncing the "same" store concurrently is a corruption path the lock was
 * never designed to arbitrate across machines.
 */
const CLOUD_SYNC_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "iCloud Drive", pattern: /Library[/\\]Mobile Documents/i },
  { label: "macOS CloudStorage mount (Dropbox/Drive/OneDrive/Box)", pattern: /Library[/\\]CloudStorage/i },
  { label: "Dropbox", pattern: /(^|[/\\])Dropbox([/\\]|$)/i },
  { label: "Google Drive", pattern: /Google ?Drive/i },
  { label: "OneDrive", pattern: /OneDrive/i }
];

/**
 * DS-11 check 1/4 — is Muse's state directory sitting inside a known
 * cloud-sync folder? Pure string match against `statePath`, so there is no
 * I/O to fail on.
 */
export function cloudSyncFolderCheck(statePath: string): LocalCheck {
  const match = CLOUD_SYNC_PATTERNS.find((candidate) => candidate.pattern.test(statePath));
  if (!match) {
    return { detail: `${statePath} is on local, non-cloud-synced storage`, name: "state dir placement", status: "ok" };
  }
  return {
    detail: `${statePath} is inside a cloud-sync folder (${match.label}) — multi-device sync can race Muse's local file-store lock and corrupt concurrent writes. Move MUSE_HOME to local, non-synced storage (e.g. ~/.muse)`,
    name: "state dir placement",
    status: "warn"
  };
}

/**
 * DS-11 check 2/4 — is Muse's state directory on a volatile (tmpfs/ramfs)
 * mount? Linux-only, best-effort via `/proc/mounts`. macOS/other platforms
 * return `undefined` so the check is silently OMITTED there rather than
 * adding a line doctor can't act on. Any read/parse failure degrades to a
 * soft "skipped" verdict — this must never throw and take `muse doctor`
 * down with it.
 */
export async function volatileMountCheck(
  statePath: string,
  platform: NodeJS.Platform = process.platform,
  readMounts: () => Promise<string> = () => fs.readFile("/proc/mounts", "utf8")
): Promise<LocalCheck | undefined> {
  if (platform !== "linux") {
    return undefined;
  }
  try {
    const raw = await readMounts();
    let best: { readonly mountPoint: string; readonly fsType: string } | undefined;
    for (const line of raw.split("\n")) {
      const fields = line.trim().split(/\s+/);
      const mountPoint = fields[1];
      const fsType = fields[2];
      if (!mountPoint || !fsType) continue;
      const underMount = statePath === mountPoint || statePath.startsWith(`${mountPoint === "/" ? "" : mountPoint}/`);
      if (!underMount) continue;
      if (!best || mountPoint.length > best.mountPoint.length) {
        best = { fsType, mountPoint };
      }
    }
    if (!best) {
      return { detail: `could not determine the mount for ${statePath} — skipped`, name: "state dir mount", status: "ok" };
    }
    if (best.fsType === "tmpfs" || best.fsType === "ramfs") {
      return {
        detail: `${statePath} is on a volatile ${best.fsType} mount (${best.mountPoint}) — sessions, credentials, and memory will NOT survive a reboot. Move MUSE_HOME to persistent storage`,
        name: "state dir mount",
        status: "warn"
      };
    }
    return { detail: `${statePath} is on a persistent ${best.fsType} mount`, name: "state dir mount", status: "ok" };
  } catch {
    return { detail: "could not read mount info — skipped", name: "state dir mount", status: "ok" };
  }
}

export interface SensitiveFileTarget {
  readonly label: string;
  readonly path: string;
}

interface SensitiveFileModeResult extends SensitiveFileTarget {
  readonly mode: number | undefined;
}

/**
 * Stat each known sensitive store file and report its mode. `mode:
 * undefined` means missing/unreadable — NOT an error, a store that hasn't
 * been written yet is normal. Never throws: a per-file stat failure is
 * swallowed individually so one bad path can't take the whole check down.
 */
export async function readSensitiveFileModes(
  targets: readonly SensitiveFileTarget[],
  statFn: (path: string) => Promise<{ readonly mode: number }> = (p) => fs.stat(p)
): Promise<SensitiveFileModeResult[]> {
  const results: SensitiveFileModeResult[] = [];
  for (const target of targets) {
    try {
      const stat = await statFn(target.path);
      results.push({ ...target, mode: stat.mode });
    } catch {
      results.push({ ...target, mode: undefined });
    }
  }
  return results;
}

/**
 * DS-11 check 3/4 — generalizes the live finding (`recall-hits.json` found
 * at mode 644, looser than the 600 every personal store writes by default)
 * across every known sensitive file, so it catches drift from a restored
 * backup, a manual chmod, or a loose umask — not just the one file a probe
 * happened to notice. Pure verdict over already-read modes.
 */
export function permissionModeDriftCheck(results: readonly SensitiveFileModeResult[]): LocalCheck {
  const present = results.filter((r): r is SensitiveFileModeResult & { readonly mode: number } => r.mode !== undefined);
  if (present.length === 0) {
    return { detail: "no sensitive store files found yet — nothing to check", name: "file permissions", status: "ok" };
  }
  const drifted = present.filter((r) => (r.mode & 0o077) !== 0);
  if (drifted.length > 0) {
    const list = drifted.map((r) => `${r.label} (${(r.mode & 0o777).toString(8)})`).join(", ");
    return {
      detail: `${drifted.length.toString()}/${present.length.toString()} sensitive file(s) are group/world-readable: ${list} — run \`chmod 600 <file>\` (Muse writes 0600 by default; a restored backup, manual chmod, or a loose umask can drift this)`,
      name: "file permissions",
      status: "warn"
    };
  }
  return { detail: `${present.length.toString()} sensitive store file(s) checked — all owner-only (0600)`, name: "file permissions", status: "ok" };
}

/**
 * DS-11 check 4/4 — floor for `MUSE_MAX_TOOL_OUTPUT_CHARS` (default 8_000,
 * see `runtime-assembly.ts`). Mirrors the runtime's own internal
 * `TOOL_OUTPUT_MIN_CAP` (`packages/memory/src/tool-output-importance.ts`,
 * 1_000 chars) — that floor only clamps the context-window AUTO-scaling
 * path; a raw env override bypasses it entirely, so e.g.
 * `MUSE_MAX_TOOL_OUTPUT_CHARS=50` truncates a typical tool's JSON reply
 * mid-object. Per the non-negotiable "tool output is untrusted, tool loops
 * have explicit limits" — a limit set too tight silently starves the
 * grounding/citation gate instead of protecting anything.
 */
export const TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS = 1_000;

/**
 * Runner sandbox posture (`MUSE_RUNNER_SANDBOX=seatbelt`) — whether risky
 * local execution through `crates/runner` actually runs confined. Off is not a failure (opt-in), but a request on a non-macOS
 * platform is worth a warn: the runner falls back to unsandboxed rather than
 * refusing, so the user should know execution is NOT actually confined there.
 */
export function runnerSandboxPostureCheck(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform
): LocalCheck {
  const name = "runner sandbox";
  const requested = env.MUSE_RUNNER_SANDBOX?.trim() === "seatbelt";
  if (!requested) {
    return { detail: "off (default) — set MUSE_RUNNER_SANDBOX=seatbelt to confine runner exec writes to cwd + $TMPDIR + caches (macOS only)", name, status: "ok" };
  }
  if (platform === "darwin") {
    return { detail: "seatbelt active (exec writes confined to cwd + $TMPDIR + caches; network opt-in per request)", name, status: "ok" };
  }
  return { detail: "MUSE_RUNNER_SANDBOX=seatbelt is set but unsupported on this platform — commands run unsandboxed", name, status: "warn" };
}

export function toolResultCapAdvisoryCheck(env: Record<string, string | undefined>): LocalCheck {
  const name = "tool-result cap";
  try {
    const raw = env.MUSE_MAX_TOOL_OUTPUT_CHARS?.trim();
    if (!raw) {
      return { detail: "MUSE_MAX_TOOL_OUTPUT_CHARS not set — default 8,000 chars (~2,000 tokens) per tool result", name, status: "ok" };
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return { detail: `MUSE_MAX_TOOL_OUTPUT_CHARS='${raw}' is not a number — the runtime falls back to the 8,000-char default`, name, status: "ok" };
    }
    if (parsed <= 0) {
      return { detail: "MUSE_MAX_TOOL_OUTPUT_CHARS is 0 or negative — the tool-output cap is DISABLED (results pass through uncapped)", name, status: "ok" };
    }
    if (parsed < TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS) {
      return {
        detail: `MUSE_MAX_TOOL_OUTPUT_CHARS=${parsed.toString()} is below the ${TOOL_OUTPUT_CAP_ADVISORY_FLOOR_CHARS.toString()}-char sane floor — a typical tool's JSON reply will truncate mid-response, starving the grounding/citation gate of evidence. Raise it (8,000 is the default) unless you have a specific reason to cap this low`,
        name,
        status: "warn"
      };
    }
    return { detail: `MUSE_MAX_TOOL_OUTPUT_CHARS=${parsed.toString()} — above the sane floor`, name, status: "ok" };
  } catch {
    return { detail: "could not evaluate MUSE_MAX_TOOL_OUTPUT_CHARS — skipped", name, status: "ok" };
  }
}
