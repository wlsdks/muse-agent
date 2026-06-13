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
import { isLoopbackUrl } from "@muse/model";

import { resolveEmbedderBase } from "./embedder-base.js";
import { OPENAI_COMPAT_PRESETS } from "./openai-compat-presets.js";
import { createModelProvider } from "./autoconfigure-model-provider.js";

export interface SetupStatusSnapshot {
  readonly model: {
    readonly status: "ok" | "todo";
    readonly muse_model?: string;
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
  // Local-only is the DEFAULT (Muse is local-by-construction); a cloud
  // provider requires an explicit MUSE_LOCAL_ONLY=false opt-out.
  const enabled = parseBoolean(env.MUSE_LOCAL_ONLY, true);
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
      if (!isLoopbackUrl(embedBase)) {
        return { detail: `🔒 on, but OLLAMA_BASE_URL points off-box (${embedBase}) — the embedder fails closed, so recall/memory embedding refuses; point OLLAMA_BASE_URL at localhost`, enabled, status: "fail" };
      }
      return { detail: "🔒 on (default) — cloud LLM + voice egress blocked (fail-closed to local)", enabled, status: "ok" };
    } catch (cause) {
      return { detail: cause instanceof Error ? cause.message : "cloud provider selected under local-only", enabled, status: "fail" };
    }
  }
  const cloudKey = CLOUD_CREDENTIAL_ENV_KEYS.find((k) => (env[k] ?? "").trim().length > 0);
  return cloudKey
    ? { detail: `⚠️ OFF by explicit opt-out — cloud egress possible (${cloudKey} set); unset MUSE_LOCAL_ONLY to restore the zero-egress guarantee`, enabled, status: "warn" }
    : { detail: "off by explicit opt-out (no cloud credentials configured)", enabled, status: "ok" };
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
  readonly nextStep?: string;
}

export function readActuatorReadiness(env: Readonly<Record<string, string | undefined>>): ActuatorReadinessSnapshot {
  const email = Boolean(env.MUSE_GMAIL_TOKEN?.trim());
  const home = Boolean(env.MUSE_HOMEASSISTANT_URL?.trim() && env.MUSE_HOMEASSISTANT_TOKEN?.trim());
  const hints: string[] = [];
  if (!email) {
    hints.push("set MUSE_GMAIL_TOKEN for email_send");
  }
  if (!home) {
    hints.push("set MUSE_HOMEASSISTANT_URL + MUSE_HOMEASSISTANT_TOKEN for home_action");
  }
  return {
    email,
    home,
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
 * Capture a fresh snapshot of the user's setup state. Both surfaces
 * (CLI --json, REST /api/setup/status) call this with no arguments;
 * the env-merge mirrors autoconfigure's runtime boot so the snapshot
 * reflects what the next `muse` invocation will see, not just raw
 * process.env.
 */
export async function collectSetupStatusJson(): Promise<SetupStatusSnapshot> {
  const env = mergeModelKeysFromFile(process.env as Record<string, string | undefined>);
  const home = homedir();

  const modelKeysFile = env.MUSE_MODEL_KEYS_FILE?.trim() && env.MUSE_MODEL_KEYS_FILE.trim().length > 0
    ? env.MUSE_MODEL_KEYS_FILE.trim()
    : pathJoin(home, ".muse", "models.json");
  const providerKeys = await readModelKeyState(modelKeysFile, env);
  const museModel = env.MUSE_MODEL?.trim() ?? "";

  const mcpFile = env.MUSE_MCP_CONFIG?.trim() && env.MUSE_MCP_CONFIG.trim().length > 0
    ? env.MUSE_MCP_CONFIG.trim()
    : pathJoin(home, ".muse", "mcp.json");
  const mcpCount = await readMcpEntryCount(mcpFile);

  const calendarFile = resolveLocalCalendarFile(env);
  const calendarBytes = await statBytes(calendarFile);
  const credentialsFile = pathJoin(home, ".muse", "credentials.json");
  const credentialsBytes = await statBytes(credentialsFile);

  const notesDir = resolveNotesDir(env);
  const notesCount = await countNotes(notesDir);
  const tasksFile = resolveTasksFile(env);
  const tasksCount = await readTaskCount(tasksFile);

  const voiceStatus = resolveVoiceStatus(env);

  const messagingFile = resolveMessagingCredentialsFile(env);
  const messagingHits = await readMessagingProviderState(messagingFile, env);

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

  const modelStatus = museModel.length > 0 || providerKeys.length > 0 ? "ok" : "todo";
  const calendarLocalStatus = calendarBytes !== undefined ? "ok" : "info";
  const credentialsStatus = credentialsBytes !== undefined ? "ok" : "info";
  return {
    localOnly: evaluateLocalOnlyPosture(env),
    calendar: {
      credentials: {
        file: credentialsFile,
        status: credentialsStatus,
        ...(credentialsStatus === "info"
          ? { nextStep: "Run `muse setup calendar` for OAuth / CalDAV / macOS credentials" }
          : {})
      },
      local: {
        file: calendarFile,
        status: calendarLocalStatus,
        ...(calendarBytes !== undefined ? { bytes: calendarBytes } : {}),
        ...(calendarLocalStatus === "info"
          ? { nextStep: "Local calendar materialises on first `muse cal add` / API call" }
          : {})
      }
    },
    messaging: {
      providers: messagingHits,
      status: messagingHits.length > 0 ? "ok" : "info",
      ...(messagingHits.length === 0
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
    model: {
      keysFile: modelKeysFile,
      providerKeys,
      status: modelStatus,
      ...(museModel.length > 0 ? { muse_model: museModel } : {}),
      ...(modelStatus === "todo"
        ? { nextStep: "Run `muse setup model` to wire OpenAI / Anthropic / Gemini / OpenRouter / Ollama / Groq / DeepSeek / Together / Mistral / Moonshot / Cerebras" }
        : {})
    },
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
        ? { nextStep: "Tasks file materialises on first `muse task add`" }
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
    actuators: readActuatorReadiness(env)
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

export async function readMessagingProviderState(file: string, env: MuseEnvironment): Promise<readonly string[]> {
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
