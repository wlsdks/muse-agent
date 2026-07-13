/**
 * Setup-status snapshot — shared shape consumed by `muse setup --json`
 * (apps/cli) and `GET /api/setup/status` (apps/api). Both surfaces
 * agree on a single source of truth: model / mcp / calendar / notes
 * / tasks / voice / messaging sections, each with a coarse
 * `status: "ok" | "todo" | "info"` plus section-specific detail.
 *
 * The detection helpers (readModelKeyState etc.) are also exported
 * so the CLI text renderer can keep showing the same data points
 * without re-implementing the per-file scans.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { isRecord } from "@muse/shared";

import { parseBoolean, parseBooleanTriState, parseInteger } from "./env-parsers.js";
import {
  mergeModelKeysFromFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveNotesDir,
  resolveTasksFile,
  type MuseEnvironment
} from "./index.js";
import type { ResolvedIntegrationEnvironment } from "./integration-environment.js";
import { resolveCredentialsFile } from "./provider-paths.js";
import { canonicalizeLocalOnlyModelBaseUrl, evaluateWebEgressPosture, isInteractiveWebEgressAllowed, isLocalOnlyEnabled } from "@muse/model";

import { resolveEmbedderBase } from "./embedder-base.js";
import { OPENAI_COMPAT_PRESETS } from "./openai-compat-presets.js";
import { createModelProvider, LOCAL_FIRST_DEFAULT_MODEL, resolveDefaultModel } from "./autoconfigure-model-provider.js";
import { resolveHomeAssistantEnvironment, type ResolvedHomeAssistantEnvironment } from "./home-assistant-environment.js";

// A supplied ResolvedIntegrationEnvironment is the only authority for the
// calendar/messaging slice of API setup status. Keep its source fields out of
// the ambient status view before model-key merging: mergeModelKeysFromFile can
// spread every enumerable key from its input when the model file is nonempty.
const SNAPSHOT_HIDDEN_INTEGRATION_ENV_KEYS = new Set([
  "MUSE_CALDAV_APP_PASSWORD",
  "MUSE_CALDAV_URL",
  "MUSE_CALDAV_USERNAME",
  "MUSE_CALENDAR_FILE",
  "MUSE_CALENDAR_ICS_FILE",
  "MUSE_CALENDAR_PROVIDERS",
  "MUSE_CHANNEL_OWNERS_FILE",
  "MUSE_CHANNEL_PAIRING_CODES_FILE",
  "MUSE_CREDENTIALS_FILE",
  "MUSE_DISCORD_AFTER_FILE",
  "MUSE_DISCORD_BOT_TOKEN",
  "MUSE_DISCORD_INBOX_FILE",
  "MUSE_DISCORD_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_GCAL_CALENDAR_ID",
  "MUSE_GCAL_CLIENT_ID",
  "MUSE_GCAL_CLIENT_SECRET",
  "MUSE_GCAL_REFRESH_TOKEN",
  "MUSE_HOMEASSISTANT_TOKEN",
  "MUSE_HOMEASSISTANT_URL",
  "MUSE_LINE_CHANNEL_ACCESS_TOKEN",
  "MUSE_LINE_CHANNEL_SECRET",
  "MUSE_LINE_INBOX_FILE",
  "MUSE_LINE_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_MATRIX_ACCESS_TOKEN",
  "MUSE_MATRIX_HOMESERVER_URL",
  "MUSE_MATRIX_INBOX_FILE",
  "MUSE_MATRIX_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_MATRIX_SINCE_FILE",
  "MUSE_MESSAGING_CREDENTIALS_FILE",
  "MUSE_NOTION_DATABASE_ID",
  "MUSE_NOTION_TITLE_PROPERTY",
  "MUSE_NOTION_TOKEN",
  "MUSE_SLACK_AFTER_FILE",
  "MUSE_SLACK_BOT_TOKEN",
  "MUSE_SLACK_INBOX_FILE",
  "MUSE_SLACK_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_TELEGRAM_BOT_TOKEN",
  "MUSE_TELEGRAM_INBOX_FILE",
  "MUSE_TELEGRAM_INBOX_INJECTION_CURSOR_FILE",
  "MUSE_TELEGRAM_OFFSET_FILE"
]);

function isSnapshotHiddenIntegrationKey(property: PropertyKey): boolean {
  return typeof property === "string" && SNAPSHOT_HIDDEN_INTEGRATION_ENV_KEYS.has(property);
}

// `collectSetupStatusJson` only needs this bounded non-integration subset from
// ambient state when an API composition snapshot is present. Keeping the list
// explicit is intentional: enumerating an arbitrary source environment would
// invoke an ambient Proxy's ownKeys/descriptor traps and could re-expose a
// calendar or messaging field before the snapshot boundary is applied.
const SNAPSHOT_VISIBLE_STATUS_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "HOME",
  "MUSE_APP_NAME",
  "MUSE_CREDENTIALS_ENCRYPT",
  "MUSE_DEFAULT_MODEL",
  "MUSE_GMAIL_TOKEN",
  "MUSE_LOCAL_ONLY",
  "MUSE_MCP_CONFIG",
  "MUSE_MEMORY_KEY",
  "MUSE_MODEL",
  "MUSE_MODEL_API_KEY",
  "MUSE_MODEL_BASE_URL",
  "MUSE_MODEL_EXTRA_HEADERS",
  "MUSE_MODEL_KEYS_FILE",
  "MUSE_MODEL_LIST",
  "MUSE_MODEL_PROVIDER_ID",
  "MUSE_NOTES_DIR",
  "MUSE_OLLAMA_NUM_BATCH",
  "MUSE_OLLAMA_NUM_CTX",
  "MUSE_OLLAMA_NUM_GPU",
  "MUSE_OLLAMA_NUM_PREDICT",
  "MUSE_OLLAMA_NUM_THREAD",
  "MUSE_OLLAMA_PROBE_CONTEXT",
  "MUSE_PIPER_VOICE",
  "MUSE_PROACTIVE_AGENT_TURN",
  "MUSE_PROACTIVE_DESTINATION",
  "MUSE_PROACTIVE_LEAD_MINUTES",
  "MUSE_PROACTIVE_PROVIDER",
  "MUSE_PROACTIVE_QUIET_HOURS",
  "MUSE_PROACTIVE_SIDECAR_FILE",
  "MUSE_PROACTIVE_TICK_MS",
  "MUSE_REMINDER_AGENT_TURN",
  "MUSE_REMINDER_DEFAULT_DESTINATION",
  "MUSE_REMINDER_DEFAULT_PROVIDER",
  "MUSE_REMINDER_QUIET_HOURS",
  "MUSE_REMINDER_TICK_MS",
  "MUSE_SITE_URL",
  "MUSE_TASKS_FILE",
  "MUSE_USER_MEMORY_AUTO_EXTRACT",
  "MUSE_USER_MEMORY_AUTO_EXTRACT_MODEL",
  "MUSE_VOICE_OPENAI_API_KEY",
  "MUSE_VOICE_STT",
  "MUSE_VOICE_TTS",
  "MUSE_WEB_EGRESS",
  "MUSE_WEB_SEARCH",
  "MUSE_WEB_SEARCH_MAX_USES",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  ...Object.values(OPENAI_COMPAT_PRESETS).map((preset) => preset.envKey)
]);

function isSnapshotVisibleStatusEnvironmentKey(property: PropertyKey): property is string {
  return typeof property === "string" && SNAPSHOT_VISIBLE_STATUS_ENV_KEYS.has(property);
}

/**
 * Read-only, non-integration view of ambient status input for an API request
 * that already owns a narrow integration snapshot. This must remain a view
 * instead of a spread: model-key merge itself spreads its input for a
 * nonempty key file, so hidden keys must be absent before that call.
 */
function createSnapshotStatusEnvironmentView(
  sourceEnv: MuseEnvironment,
  localOnly: boolean
): MuseEnvironment {
  const localOnlyValue = localOnly ? "true" : "false";
  // Snapshot only present, explicitly allowed values. In particular, absent
  // ambient keys must stay absent from ownKeys so `{ ...env }` in the model
  // key merge cannot overwrite a suggested model with `undefined`.
  const visibleValues = new Map<string, string>();
  for (const key of SNAPSHOT_VISIBLE_STATUS_ENV_KEYS) {
    // Gmail is deliberately not even read from the source when the frozen
    // snapshot is local-only. Status can report it as disabled without
    // probing a credential-protecting environment.
    if (key === "MUSE_LOCAL_ONLY" || (localOnly && key === "MUSE_GMAIL_TOKEN")) {
      continue;
    }
    const value = sourceEnv[key];
    if (value !== undefined) {
      visibleValues.set(key, value);
    }
  }
  // Never use `sourceEnv` as the Proxy target. An ambient environment can be
  // another Proxy whose invariant validation reaches hidden descriptors when
  // this view filters ownKeys. A fresh extensible, null-prototype target keeps
  // every virtual key configurable and makes all traps self-contained.
  const snapshotTarget = Object.create(null) as Record<string, never>;
  return new Proxy(snapshotTarget, {
    defineProperty: () => false,
    deleteProperty: () => false,
    get(_target, property) {
      if (property === "MUSE_LOCAL_ONLY") {
        return localOnlyValue;
      }
      if (localOnly && property === "MUSE_GMAIL_TOKEN") {
        return undefined;
      }
      if (isSnapshotHiddenIntegrationKey(property)) {
        return undefined;
      }
      if (isSnapshotVisibleStatusEnvironmentKey(property)) {
        return visibleValues.get(property);
      }
      // Symbols are not part of the enumerable status snapshot, but forwarding
      // their read preserves ordinary object interop without probing strings.
      return typeof property === "symbol" ? Reflect.get(sourceEnv, property) : undefined;
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property === "MUSE_LOCAL_ONLY") {
        return { configurable: true, enumerable: true, value: localOnlyValue, writable: false };
      }
      if (isSnapshotVisibleStatusEnvironmentKey(property) && visibleValues.has(property)) {
        return {
          configurable: true,
          enumerable: true,
          value: visibleValues.get(property),
          writable: false
        };
      }
      return undefined;
    },
    has(_target, property) {
      return property === "MUSE_LOCAL_ONLY"
        || (isSnapshotVisibleStatusEnvironmentKey(property) && visibleValues.has(property));
    },
    ownKeys() {
      return ["MUSE_LOCAL_ONLY", ...visibleValues.keys()];
    },
    preventExtensions: () => false,
    set: () => false
  });
}

export interface SetupStatusSnapshot {
  readonly model: {
    readonly status: "ok" | "todo";
    /** The MUSE_MODEL env var, when explicitly set (post models.json merge). */
    readonly muse_model?: string;
    /**
     * The model the runtime will ACTUALLY use — mirrors `muse doctor`'s
     * model-env line (`resolveDefaultModel`). `buildModelSection` always
     * populates it: a fresh local box resolves to the local default
     * (`ollama/gemma4:12b`), never nothing. Optional only so pre-existing
     * literal fixtures need not restate it.
     */
    readonly resolvedModel?: string;
    /** Where `resolvedModel` came from, so a surface can label it truthfully. */
    readonly modelSource?: "env" | "config" | "cloud" | "local-default";
    readonly keysFile: string;
    readonly providerKeys: readonly string[];
    readonly nextStep?: string;
  };
  readonly mcp: {
    readonly status: "ok" | "info";
    readonly file: string;
    readonly externalServerCount: number;
    readonly nextStep?: string;
  };
  readonly calendar: {
    readonly local: { readonly status: "ok" | "info"; readonly file: string; readonly bytes?: number; readonly nextStep?: string };
    readonly credentials: { readonly status: "ok" | "info"; readonly file: string; readonly nextStep?: string };
  };
  readonly notes: { readonly status: "ok" | "info"; readonly dir: string; readonly fileCount?: number; readonly nextStep?: string };
  readonly tasks: { readonly status: "ok" | "info"; readonly file: string; readonly entryCount?: number; readonly nextStep?: string };
  readonly voice: {
    readonly status: "ok" | "info";
    readonly source: "openai_api_key" | "muse_voice_openai_api_key" | "none";
    /**
     * Resolved STT backend after autoconfigure's
     * `MUSE_VOICE_STT` resolution. `none` when no provider is wired.
     */
    readonly sttBackend: "openai-whisper" | "whisper-cpp" | "none";
    /** Resolved TTS backend (MUSE_VOICE_TTS=piper requires MUSE_PIPER_VOICE). */
    readonly ttsBackend: "openai-tts" | "piper" | "none";
    readonly nextStep?: string;
  };
  readonly messaging: { readonly status: "ok" | "info"; readonly providers: readonly string[]; readonly nextStep?: string };
  readonly webSearch: { readonly status: "ok" | "info"; readonly enabled: boolean; readonly maxUses: number; readonly source: "default" | "env" };
  readonly userMemory: {
    readonly status: "ok" | "info";
    /** `true` when the auto-extract hook is currently active. */
    readonly autoExtract: boolean;
    /** Resolved extraction model when auto-extract is on (`undefined` when off). */
    readonly model?: string;
    readonly nextStep?: string;
  };
  readonly proactive: {
    readonly status: "ok" | "info";
    /** `true` when the daemon would actually start given current env. */
    readonly enabled: boolean;
    readonly providerId?: string;
    readonly destination?: string;
    readonly leadMinutes: number;
    readonly tickMs: number;
    /** Phase D — when `true`, fired notices spawn a one-shot agent run. */
    readonly agentTurn: boolean;
    /** Effective quiet-hours window (proactive override > reminder share > none). */
    readonly quietHours?: string;
    readonly sidecarFile: string;
    readonly nextStep?: string;
  };
  readonly reminder: {
    readonly status: "ok" | "info";
    /** `true` when the reminder firing daemon would activate. */
    readonly enabled: boolean;
    readonly providerId?: string;
    readonly destination?: string;
    readonly tickMs: number;
    /** Phase D — when `true`, fired reminders run through agent synthesis. */
    readonly agentTurn: boolean;
    readonly quietHours?: string;
    readonly nextStep?: string;
  };
  readonly actuators: ActuatorReadinessSnapshot;
  readonly localOnly: LocalOnlyStatusSnapshot;
  readonly webEgress: WebEgressStatusSnapshot;
}

/**
 * Web-egress posture (MUSE_WEB_EGRESS) — the master switch for reaching the
 * public web (search / web read / download / web action). Orthogonal to
 * localOnly: a user can keep the local-LLM guarantee AND search the web (the
 * default), or turn this off for a true zero-outbound posture.
 */
export interface WebEgressStatusSnapshot {
  readonly enabled: boolean;
  readonly status: "ok";
  readonly detail: string;
}

export function evaluateWebEgressStatus(env: Readonly<Record<string, string | undefined>>): WebEgressStatusSnapshot {
  const { enabled: webEgressEnabled } = evaluateWebEgressPosture(env);
  const enabled = isInteractiveWebEgressAllowed(env);
  return {
    detail: enabled
      ? "🌐 on (default) — Muse interactive public-web search / read / download available"
      : isLocalOnlyEnabled(env)
        ? "🔒 local-only — Muse interactive public-web tools are disabled in T2-A1; this is not a complete all-egress audit"
        : webEgressEnabled
          ? "✈️ off — Muse interactive public-web tools unavailable; this is not a complete all-egress audit"
          : "✈️ off — Muse interactive public-web tools disabled by MUSE_WEB_EGRESS; this is not a complete all-egress audit",
    enabled,
    status: "ok"
  };
}

/**
 * Local-only / no-cloud-egress posture (MUSE_LOCAL_ONLY). The single
 * source of truth shared by `muse doctor` and `muse setup status` so the
 * two surfaces can never disagree about whether the privacy guarantee is
 * in force. `fail` previews the runtime's own boot refusal (local-only on
 * but a cloud model configured); `warn` flags that egress is possible
 * because local-only is off while a cloud credential is present.
 */
export interface LocalOnlyStatusSnapshot {
  readonly enabled: boolean;
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

const CLOUD_CREDENTIAL_ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] as const;

export function evaluateLocalOnlyPosture(env: Readonly<Record<string, string | undefined>>): LocalOnlyStatusSnapshot {
  // Local-only is an OPT-IN posture (MUSE_LOCAL_ONLY=true); cloud is allowed by
  // default. When opted in, the runtime fail-closes on any cloud provider.
  const enabled = parseBoolean(env.MUSE_LOCAL_ONLY, false);
  if (enabled) {
    try {
      // Runs the SAME fail-close the runtime does at boot, so the report
      // and the actual startup outcome can never diverge.
      createModelProvider(env);
      // The embedder reads OLLAMA_BASE_URL independently of the chat model, so a
      // loopback chat model + a remote OLLAMA_BASE_URL clears createModelProvider
      // yet egresses the user's note/memory text. Mirror the embedder's own
      // construction-time fail-close so doctor surfaces it instead of reporting ok.
      const embedBase = resolveEmbedderBase(env);
      try {
        canonicalizeLocalOnlyModelBaseUrl("ollama", embedBase);
      } catch {
        return { detail: `🔒 on, but OLLAMA_BASE_URL points off-box (${embedBase}) — the embedder fails closed, so recall/memory embedding refuses; point OLLAMA_BASE_URL at localhost`, enabled, status: "fail" };
      }
      return {
        detail: "🔒 on — cloud model + voice egress blocked and Gmail standard paths disabled; Home Assistant remote paths are disabled while MUSE_LOCAL_ONLY=true; canonical loopback remains available; Muse interactive public-web tools (T2-A1), external MCP transports (T2-A2), and T2-B1 standard remote calendar/messaging assembly/setup disabled; local file, exported ICS, and macOS Calendar.app remain available (set MUSE_MACOS_CALENDAR_NAME to scope Calendar.app); not a complete all-egress audit",
        enabled,
        status: "ok"
      };
    } catch (cause) {
      return { detail: cause instanceof Error ? cause.message : "cloud provider selected under local-only", enabled, status: "fail" };
    }
  }
  const cloudKey = CLOUD_CREDENTIAL_ENV_KEYS.find((k) => (env[k] ?? "").trim().length > 0);
  return cloudKey
    ? { detail: `⚠️ local-only off — cloud egress possible (${cloudKey} set); set MUSE_LOCAL_ONLY=true to force local-only`, enabled, status: "warn" }
    : { detail: "local-only off — cloud allowed (no cloud credentials set)", enabled, status: "ok" };
}

export interface WebSearchEnvSnapshot {
  readonly enabled: boolean;
  readonly maxUses: number;
  readonly source: "default" | "env";
}

export interface ActuatorReadinessSnapshot {
  readonly status: "ok" | "info";
  /** MUSE_GMAIL_TOKEN present → email_send can be armed. */
  readonly email: boolean;
  /** Always available — the generic gated web action needs no provider env. */
  readonly web: boolean;
  /** Both MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN present. */
  readonly home: boolean;
  /** Present only when local-only refused a non-loopback HA endpoint. */
  readonly homeReason?: string;
  readonly nextStep?: string;
}

export function readActuatorReadiness(
  env: MuseEnvironment,
  options: { readonly homeAssistant?: ResolvedHomeAssistantEnvironment } = {}
): ActuatorReadinessSnapshot {
  const homeAssistant = options.homeAssistant ?? resolveHomeAssistantEnvironment(env);
  const localOnly = homeAssistant.localOnly;
  // Read local-only before Gmail. A credential-protecting env Proxy is a
  // valid composition input and this status row must not become a probe.
  const email = localOnly ? false : Boolean(env.MUSE_GMAIL_TOKEN?.trim());
  const home = homeAssistant.status === "configured";
  const hints: string[] = [];
  if (!email) {
    hints.push(localOnly
      ? "Gmail email_send is disabled while MUSE_LOCAL_ONLY=true"
      : "set MUSE_GMAIL_TOKEN for email_send");
  }
  if (!home) {
    hints.push(homeAssistant.status === "blocked"
      ? homeAssistant.reason
      : "set MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN for home_action");
  }
  return {
    email,
    home,
    ...(homeAssistant.status === "blocked" ? { homeReason: homeAssistant.reason } : {}),
    status: email || home ? "ok" : "info",
    web: true,
    ...(hints.length > 0
      ? { nextStep: `Actuators are opt-in via \`muse ask --with-tools --actuators\`. ${hints.join("; ")}` }
      : {})
  };
}

const WEB_SEARCH_DEFAULTS: WebSearchEnvSnapshot = {
  enabled: true,
  maxUses: 5,
  source: "default"
};

export function readWebSearchEnvSnapshot(env: Readonly<Record<string, string | undefined>>): WebSearchEnvSnapshot {
  let source: "default" | "env" = "default";
  let enabled = WEB_SEARCH_DEFAULTS.enabled;
  let maxUses = WEB_SEARCH_DEFAULTS.maxUses;

  const flag = parseBooleanTriState(env.MUSE_WEB_SEARCH);
  if (flag === false) {
    enabled = false;
    source = "env";
  } else if (flag === true) {
    enabled = true;
    source = "env";
  }

  const rawMax = env.MUSE_WEB_SEARCH_MAX_USES;
  if (rawMax !== undefined) {
    // Strict parse, not Number.parseInt: a typo'd "5x" / unit-slip
    // "30s" must not be reported as a valid env-configured value on
    // the setup-status / `muse doctor` surface.
    const n = parseInteger(rawMax, 0);
    if (n > 0) {
      maxUses = n;
      source = "env";
    }
  }

  return { enabled, maxUses, source };
}

/**
 * Resolve the voice section the same way autoconfigure's
 * `buildVoiceRegistry` does, so `muse doctor` / setup --json report the
 * backend that will actually run. Pure (env-injected) for direct unit
 * coverage. Carries an explicit `nextStep` when `MUSE_VOICE_TTS=piper`
 * was chosen but `MUSE_PIPER_VOICE` is unset — that combination
 * silently falls back to paid OpenAI TTS (or none), which a user
 * deliberately picking local/zero-cost speech must be told about.
 */
export function resolveVoiceStatus(
  env: Readonly<Record<string, string | undefined>>
): SetupStatusSnapshot["voice"] {
  const voiceFromBase = Boolean(env.OPENAI_API_KEY?.trim());
  const voiceFromMuse = Boolean(env.MUSE_VOICE_OPENAI_API_KEY?.trim());
  const source: SetupStatusSnapshot["voice"]["source"] = voiceFromMuse
    ? "muse_voice_openai_api_key"
    : voiceFromBase ? "openai_api_key" : "none";
  const sttChoice = env.MUSE_VOICE_STT?.trim().toLowerCase();
  const ttsChoice = env.MUSE_VOICE_TTS?.trim().toLowerCase();
  const hasPiperVoice = Boolean(env.MUSE_PIPER_VOICE?.trim());
  const sttBackend: SetupStatusSnapshot["voice"]["sttBackend"] =
    sttChoice === "whisper-cpp" ? "whisper-cpp" : source !== "none" ? "openai-whisper" : "none";
  const ttsBackend: SetupStatusSnapshot["voice"]["ttsBackend"] =
    ttsChoice === "piper" && hasPiperVoice ? "piper" : source !== "none" ? "openai-tts" : "none";
  const bothNone = sttBackend === "none" && ttsBackend === "none";
  let nextStep: string | undefined;
  if (bothNone) {
    nextStep = "Run `muse setup model` and pick OpenAI, or export MUSE_VOICE_OPENAI_API_KEY, or set MUSE_VOICE_STT=whisper-cpp / MUSE_VOICE_TTS=piper + MUSE_PIPER_VOICE for local-only";
  } else if (ttsChoice === "piper" && !hasPiperVoice) {
    nextStep = `MUSE_VOICE_TTS=piper needs MUSE_PIPER_VOICE (path to a .onnx voice file); without it TTS fell back to ${ttsBackend}. Set MUSE_PIPER_VOICE for local, zero-cost speech.`;
  }
  return {
    source,
    sttBackend,
    status: bothNone ? "info" : "ok",
    ttsBackend,
    ...(nextStep ? { nextStep } : {})
  };
}

/**
 * Read the persisted `defaultModel` from the CLI config store
 * (`~/.config/muse/config.json`) — the value `muse setup local` / the
 * first-run wizard write. Setup status credits it exactly like the CLI
 * runtime does when it launches chat/ask with `--model <config.defaultModel>`.
 */
export async function readConfigDefaultModel(file: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { defaultModel?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.defaultModel === "string") {
      const trimmed = parsed.defaultModel.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  } catch {
    // missing / malformed → no persisted default
  }
  return undefined;
}

/**
 * Resolve the `model` section the SAME way `muse doctor` resolves its
 * model-env line (`resolveDefaultModel`), plus the persisted CLI-config
 * default. A model is ALWAYS resolvable — the runtime falls back to the
 * local default (`ollama/gemma4:12b`) — so this section is NEVER
 * "todo"/"not configured": a fresh local box is READY on the local
 * default, which is exactly what doctor reports. Pure (env + injected
 * config) so it is directly unit-testable without touching the filesystem.
 */
export function buildModelSection(
  env: MuseEnvironment,
  args: {
    readonly keysFile: string;
    readonly providerKeys: readonly string[];
    readonly configDefaultModel?: string;
  }
): SetupStatusSnapshot["model"] {
  const explicit = (env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL)?.trim();
  const configModel = args.configDefaultModel?.trim();
  const localOnly = parseBoolean(env.MUSE_LOCAL_ONLY, false);

  let resolvedModel: string;
  let modelSource: SetupStatusSnapshot["model"]["modelSource"];
  if (explicit && explicit.length > 0) {
    resolvedModel = explicit;
    modelSource = "env";
  } else if (configModel && configModel.length > 0) {
    // Persisted `defaultModel` — what the CLI actually launches with — wins
    // over ambient cloud-key inference (a user who ran `muse setup local`
    // chose that model on purpose).
    resolvedModel = configModel;
    modelSource = "config";
  } else {
    resolvedModel = resolveDefaultModel(env) ?? LOCAL_FIRST_DEFAULT_MODEL;
    // `resolveDefaultModel` returns the local default unless an ambient cloud
    // credential was inferred (only possible when local-only is off).
    modelSource = !localOnly && resolvedModel !== LOCAL_FIRST_DEFAULT_MODEL ? "cloud" : "local-default";
  }

  // Next-step guidance must NOT lead a local-first user toward cloud vendors.
  // On the local default it is a soft "customize" nudge; cloud discovery stays
  // available but secondary.
  const nextStep = modelSource === "local-default"
    ? `Ready on the local default ${resolvedModel}. Customize with \`muse setup local\` (other local models) — or \`muse setup model\` to add a cloud provider.`
    : undefined;

  return {
    keysFile: args.keysFile,
    modelSource,
    providerKeys: args.providerKeys,
    resolvedModel,
    status: "ok",
    ...(explicit && explicit.length > 0 ? { muse_model: explicit } : {}),
    ...(nextStep ? { nextStep } : {})
  };
}

/**
 * Capture a fresh snapshot of the user's setup state. Both surfaces
 * (CLI --json, REST /api/setup/status) call this with no arguments;
 * the env-merge mirrors autoconfigure's runtime boot so the snapshot
 * reflects what the next `muse` invocation will see, not just raw
 * process.env.
 */
export async function collectSetupStatusJson(options: {
  /** Test/composition seam; CLI callers retain the process-env default. */
  readonly env?: MuseEnvironment;
  readonly integrationEnv?: ResolvedIntegrationEnvironment;
} = {}): Promise<SetupStatusSnapshot> {
  const integrationEnv = options.integrationEnv;
  const sourceEnv: MuseEnvironment = options.env ?? process.env;
  // Resolve the HA pair before constructing any model/status overlay. In
  // strict mode the resolver classifies URL first and returns on remote or
  // blank endpoints without touching the token; neither the overlay nor its
  // reflective merge can then re-open that credential.
  const homeAssistant = resolveHomeAssistantEnvironment(sourceEnv, {
    ...(integrationEnv ? { localOnlyOverride: integrationEnv.localOnly } : {})
  });
  const statusEnv = integrationEnv
    ? mergeModelKeysFromFile(createSnapshotStatusEnvironmentView(sourceEnv, homeAssistant.localOnly), {
      localOnlyOverride: homeAssistant.localOnly
    })
    : mergeModelKeysFromFile(sourceEnv, { localOnlyOverride: homeAssistant.localOnly });
  const env = statusEnv;
  const integrationLocalOnly = homeAssistant.localOnly;
  const home = env.HOME?.trim() || homedir();

  const modelKeysFile = env.MUSE_MODEL_KEYS_FILE?.trim() && env.MUSE_MODEL_KEYS_FILE.trim().length > 0
    ? env.MUSE_MODEL_KEYS_FILE.trim()
    : pathJoin(home, ".muse", "models.json");
  const providerKeys = await readModelKeyState(modelKeysFile, env);
  const museModel = env.MUSE_MODEL?.trim() ?? "";
  const configDefaultModel = await readConfigDefaultModel(pathJoin(home, ".config", "muse", "config.json"));

  const mcpFile = env.MUSE_MCP_CONFIG?.trim() && env.MUSE_MCP_CONFIG.trim().length > 0
    ? env.MUSE_MCP_CONFIG.trim()
    : pathJoin(home, ".muse", "mcp.json");
  const mcpCount = await readMcpEntryCount(mcpFile);

  const calendarFile = integrationEnv?.calendar.localFile ?? resolveLocalCalendarFile(env);
  const calendarBytes = await statBytes(calendarFile);
  const credentialsFile = integrationEnv?.calendar.credentialsFile ?? resolveCredentialsFile(env);
  // Shared calendar records can hold remote Google/CalDAV secrets. Under
  // local-only, status must not stat/read them just to render a row.
  const credentialsBytes = integrationLocalOnly ? undefined : await statBytes(credentialsFile);

  const notesDir = resolveNotesDir(env);
  const notesCount = await countNotes(notesDir);
  const tasksFile = resolveTasksFile(env);
  const tasksCount = await readTaskCount(tasksFile);

  const voiceStatus = resolveVoiceStatus(env);

  const messagingFile = integrationEnv?.messaging.credentialsFile ?? resolveMessagingCredentialsFile(env);
  const messagingHits = await readMessagingProviderState(messagingFile, env, integrationEnv);

  // User-memory auto-extract (default-on as of the recent flip).
  const autoExtractEnv = env.MUSE_USER_MEMORY_AUTO_EXTRACT?.trim().toLowerCase();
  const autoExtractEnabled = autoExtractEnv === undefined
    ? true
    : autoExtractEnv === "true";
  const autoExtractModel = env.MUSE_USER_MEMORY_AUTO_EXTRACT_MODEL?.trim() || museModel || undefined;

  // Proactive surfacing daemon — collect raw env + compute the
  // "would activate" predicate the way server.ts does. The daemon
  // additionally requires a calendar registry OR tasksFile at runtime;
  // the snapshot can't know those without booting autoconfigure, so it
  // reports the env-gated state only.
  const proactiveProvider = env.MUSE_PROACTIVE_PROVIDER?.trim();
  const proactiveDestination = env.MUSE_PROACTIVE_DESTINATION?.trim();
  const proactiveLeadRaw = env.MUSE_PROACTIVE_LEAD_MINUTES?.trim();
  const proactiveLead = proactiveLeadRaw && /^\d+$/u.test(proactiveLeadRaw)
    ? Number.parseInt(proactiveLeadRaw, 10)
    : 10;
  const proactiveTickRaw = env.MUSE_PROACTIVE_TICK_MS?.trim();
  const proactiveTickMs = proactiveTickRaw && /^\d+$/u.test(proactiveTickRaw)
    ? Number.parseInt(proactiveTickRaw, 10)
    : 60_000;
  const proactiveAgentTurn = parseBoolean(env.MUSE_PROACTIVE_AGENT_TURN, false);
  const proactiveQuietHours = env.MUSE_PROACTIVE_QUIET_HOURS?.trim()
    || env.MUSE_REMINDER_QUIET_HOURS?.trim();
  const proactiveSidecarFile = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim()
    || pathJoin(home, ".muse", "proactive-fired.json");
  const proactiveEnabled = Boolean(proactiveProvider && proactiveDestination);

  // Reminder firing daemon (env-only view; the server also needs
  // remindersFile + the messaging registry to actually wire it).
  const reminderProvider = env.MUSE_REMINDER_DEFAULT_PROVIDER?.trim();
  const reminderDestination = env.MUSE_REMINDER_DEFAULT_DESTINATION?.trim();
  const reminderTickRaw = env.MUSE_REMINDER_TICK_MS?.trim();
  const reminderTickMs = reminderTickRaw && /^\d+$/u.test(reminderTickRaw)
    ? Number.parseInt(reminderTickRaw, 10)
    : 60_000;
  const reminderAgentTurn = parseBoolean(env.MUSE_REMINDER_AGENT_TURN, false);
  const reminderQuietHours = env.MUSE_REMINDER_QUIET_HOURS?.trim();
  const reminderEnabled = Boolean(reminderProvider && reminderDestination);

  const calendarLocalStatus = calendarBytes !== undefined ? "ok" : "info";
  const credentialsStatus = credentialsBytes !== undefined ? "ok" : "info";
  return {
    localOnly: evaluateLocalOnlyPosture(statusEnv),
    // A supplied API integration snapshot owns the local-only posture. Keep
    // the adjacent T2-A1 status row coherent with that same boolean instead
    // of accidentally reporting ambient public-web availability.
    webEgress: evaluateWebEgressStatus(statusEnv),
    calendar: {
      credentials: {
        file: credentialsFile,
        status: credentialsStatus,
        ...(integrationLocalOnly
          ? {
            nextStep: "Remote Google/CalDAV setup is disabled while MUSE_LOCAL_ONLY=true. Local file, exported ICS, and macOS Calendar.app remain available; set MUSE_MACOS_CALENDAR_NAME to scope Calendar.app."
          }
          : credentialsStatus === "info"
          ? { nextStep: "Run `muse setup calendar` for OAuth / CalDAV / macOS credentials" }
          : {})
      },
      local: {
        file: calendarFile,
        status: calendarLocalStatus,
        ...(calendarBytes !== undefined ? { bytes: calendarBytes } : {}),
        ...(calendarLocalStatus === "info"
          ? { nextStep: "Local calendar materialises on first `muse calendar add` / API call" }
          : {})
      }
    },
    messaging: {
      providers: messagingHits,
      status: messagingHits.length > 0 ? "ok" : "info",
      ...(integrationLocalOnly
        ? { nextStep: "Remote messaging setup is disabled while MUSE_LOCAL_ONLY=true; local log/native notifications remain available." }
        : messagingHits.length === 0
        ? { nextStep: "Run `muse setup messaging` for Telegram / Discord / Slack / LINE tokens" }
        : {})
    },
    mcp: {
      externalServerCount: mcpCount,
      file: mcpFile,
      status: mcpCount > 0 ? "ok" : "info",
      ...(mcpCount === 0
        ? { nextStep: "Add external servers with `muse mcp config-add` or via /api/admin/mcp/*" }
        : {})
    },
    model: buildModelSection(env, { configDefaultModel, keysFile: modelKeysFile, providerKeys }),
    notes: {
      dir: notesDir,
      status: notesCount !== undefined ? "ok" : "info",
      ...(notesCount !== undefined ? { fileCount: notesCount } : {}),
      ...(notesCount === undefined
        ? { nextStep: "Notes directory materialises on first `muse notes save`" }
        : {})
    },
    tasks: {
      file: tasksFile,
      status: tasksCount !== undefined ? "ok" : "info",
      ...(tasksCount !== undefined ? { entryCount: tasksCount } : {}),
      ...(tasksCount === undefined
        ? { nextStep: "Tasks file materialises on first `muse tasks add`" }
        : {})
    },
    voice: voiceStatus,
    webSearch: {
      ...readWebSearchEnvSnapshot(env),
      status: "ok" as const
    },
    userMemory: {
      autoExtract: autoExtractEnabled,
      status: "ok" as const,
      ...(autoExtractEnabled && autoExtractModel ? { model: autoExtractModel } : {}),
      ...(autoExtractEnabled
        ? {}
        : { nextStep: "Set MUSE_USER_MEMORY_AUTO_EXTRACT=true to re-enable JARVIS-class memory capture" })
    },
    proactive: {
      agentTurn: proactiveAgentTurn,
      ...(proactiveDestination ? { destination: proactiveDestination } : {}),
      enabled: proactiveEnabled,
      leadMinutes: proactiveLead,
      ...(proactiveProvider ? { providerId: proactiveProvider } : {}),
      ...(proactiveQuietHours ? { quietHours: proactiveQuietHours } : {}),
      sidecarFile: proactiveSidecarFile,
      status: proactiveEnabled ? "ok" as const : "info" as const,
      tickMs: proactiveTickMs,
      ...(proactiveEnabled
        ? {}
        : { nextStep: "Set MUSE_PROACTIVE_PROVIDER + MUSE_PROACTIVE_DESTINATION to enable calendar/task push notices" })
    },
    reminder: {
      agentTurn: reminderAgentTurn,
      ...(reminderDestination ? { destination: reminderDestination } : {}),
      enabled: reminderEnabled,
      ...(reminderProvider ? { providerId: reminderProvider } : {}),
      ...(reminderQuietHours ? { quietHours: reminderQuietHours } : {}),
      status: reminderEnabled ? "ok" as const : "info" as const,
      tickMs: reminderTickMs,
      ...(reminderEnabled
        ? {}
        : { nextStep: "Set MUSE_REMINDER_DEFAULT_PROVIDER + MUSE_REMINDER_DEFAULT_DESTINATION to enable the reminder firing daemon" })
    },
    actuators: readActuatorReadiness(env, { homeAssistant })
  };
}

export async function readModelKeyState(file: string, env: MuseEnvironment): Promise<readonly string[]> {
  let storedProviders: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
      storedProviders = parsed.providers;
    }
  } catch {
    // missing or malformed → treat as empty
  }
  const lines: string[] = [];
  const probe = (id: string, envKey: string): void => {
    const fromEnv = env[envKey]?.trim();
    const fromFile = isRecord(storedProviders[id]) && typeof storedProviders[id].token === "string"
      ? "file"
      : undefined;
    if (fromEnv && fromEnv.length > 0) {
      lines.push(`${id} (env)`);
    } else if (fromFile) {
      lines.push(`${id} (file)`);
    }
  };
  probe("openai", "OPENAI_API_KEY");
  probe("anthropic", "ANTHROPIC_API_KEY");
  probe("gemini", "GEMINI_API_KEY");
  probe("openrouter", "OPENROUTER_API_KEY");
  probe("ollama", "OLLAMA_BASE_URL");
  for (const [id, preset] of Object.entries(OPENAI_COMPAT_PRESETS)) {
    probe(id, preset.envKey);
  }
  return lines;
}

export async function readMessagingProviderState(
  file: string,
  env: MuseEnvironment,
  integrationEnv?: ResolvedIntegrationEnvironment
): Promise<readonly string[]> {
  // A supplied API composition snapshot is authoritative for every
  // integration-derived status field. In particular, do not re-evaluate
  // ambient local-only policy or probe ambient token fields in that path.
  const localOnly = integrationEnv?.localOnly ?? isLocalOnlyEnabled(env);
  if (localOnly) {
    return [];
  }
  const credentialsFile = integrationEnv?.messaging.credentialsFile ?? file;
  let storedProviders: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(credentialsFile, "utf8");
    const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> };
    if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
      storedProviders = parsed.providers;
    }
  } catch {
    // missing or malformed → treat as empty
  }
  const lines: string[] = [];
  const probe = (id: "telegram" | "discord" | "slack" | "line", envKey: string): void => {
    const fromEnv = integrationEnv
      ? integrationEnv.messaging.providers[id].envConfigured
      : Boolean(env[envKey]?.trim());
    const fromFile = isRecord(storedProviders[id]) && typeof storedProviders[id].token === "string"
      ? "file"
      : undefined;
    if (fromEnv) {
      lines.push(`${id} (env)`);
    } else if (fromFile) {
      lines.push(`${id} (file)`);
    }
  };
  probe("telegram", "MUSE_TELEGRAM_BOT_TOKEN");
  probe("discord", "MUSE_DISCORD_BOT_TOKEN");
  probe("slack", "MUSE_SLACK_BOT_TOKEN");
  probe("line", "MUSE_LINE_CHANNEL_ACCESS_TOKEN");
  return lines;
}

export async function readMcpEntryCount(file: string): Promise<number> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return Object.keys(parsed.mcpServers).length;
    }
  } catch {
    // missing / malformed → treat as zero
  }
  return 0;
}

export async function statBytes(file: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(file);
    return stat.size;
  } catch {
    return undefined;
  }
}

export async function countNotes(dir: string): Promise<number | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.isFile() && /\.(md|markdown|txt)$/iu.test(entry.name)) {
        total += 1;
      } else if (entry.isDirectory()) {
        total += 1; // count subdirs as a single bucket without recursing — `muse today` does the deep walk
      }
    }
    return total;
  } catch {
    return undefined;
  }
}

export async function readTaskCount(file: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.tasks)) {
      return parsed.tasks.length;
    }
    return 0;
  } catch {
    return undefined;
  }
}
