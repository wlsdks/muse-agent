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

import { parseBoolean } from "./env-parsers.js";
import {
  mergeModelKeysFromFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveNotesDir,
  resolveTasksFile,
  type MuseEnvironment
} from "./index.js";
import { OPENAI_COMPAT_PRESETS } from "./openai-compat-presets.js";

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
}

export interface WebSearchEnvSnapshot {
  readonly enabled: boolean;
  readonly maxUses: number;
  readonly source: "default" | "env";
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

  const flag = env.MUSE_WEB_SEARCH?.toLowerCase();
  if (flag === "off") {
    enabled = false;
    source = "env";
  } else if (flag === "on") {
    enabled = true;
    source = "env";
  }

  const rawMax = env.MUSE_WEB_SEARCH_MAX_USES;
  if (rawMax !== undefined) {
    const n = Number.parseInt(rawMax, 10);
    if (Number.isFinite(n) && n > 0) {
      maxUses = n;
      source = "env";
    }
  }

  return { enabled, maxUses, source };
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

  const voiceFromBase = Boolean(env.OPENAI_API_KEY?.trim());
  const voiceFromMuse = Boolean(env.MUSE_VOICE_OPENAI_API_KEY?.trim());
  const voiceSource: "openai_api_key" | "muse_voice_openai_api_key" | "none" = voiceFromMuse
    ? "muse_voice_openai_api_key"
    : voiceFromBase ? "openai_api_key" : "none";
  const voiceSttChoice = env.MUSE_VOICE_STT?.trim().toLowerCase();
  const voiceTtsChoice = env.MUSE_VOICE_TTS?.trim().toLowerCase();
  const hasPiperVoice = Boolean(env.MUSE_PIPER_VOICE?.trim());
  const sttBackend: "openai-whisper" | "whisper-cpp" | "none" =
    voiceSttChoice === "whisper-cpp"
      ? "whisper-cpp"
      : voiceSource !== "none" ? "openai-whisper" : "none";
  const ttsBackend: "openai-tts" | "piper" | "none" =
    voiceTtsChoice === "piper" && hasPiperVoice
      ? "piper"
      : voiceSource !== "none" ? "openai-tts" : "none";

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
  // Goal 130 — route env flags through the goal-128 parseBoolean
  // so common admin spellings (`1`, `yes`, `on`, case-insensitive)
  // work uniformly with the rest of Muse's flag parsing instead of
  // requiring the exact literal `"true"`.
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
    voice: {
      source: voiceSource,
      sttBackend,
      status: sttBackend === "none" && ttsBackend === "none" ? "info" : "ok",
      ttsBackend,
      ...(sttBackend === "none" && ttsBackend === "none"
        ? { nextStep: "Run `muse setup model` and pick OpenAI, or export MUSE_VOICE_OPENAI_API_KEY, or set MUSE_VOICE_STT=whisper-cpp / MUSE_VOICE_TTS=piper + MUSE_PIPER_VOICE for local-only" }
        : {})
    },
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
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
