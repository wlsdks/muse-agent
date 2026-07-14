import { parseBoolean } from "@muse/autoconfigure";
import { parseQuietHours } from "@muse/proactivity";
import { toBody } from "./compat-parsers.js";

import { readDaemonSettingsSync, readQuietHoursSettingSync, writeDaemonSetting, writeQuietHoursSetting, type DaemonSettings } from "./daemon-settings-store.js";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface DaemonFlagView {
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Live handle state for channel daemons — enabled says the FLAG, running says the truth. */
  readonly running?: boolean;
  readonly lastIngestAtIso?: string;
  readonly lastError?: string;
  readonly lastErrorAtIso?: string;
}

export interface DaemonFlagsResponse {
  readonly flags: readonly DaemonFlagView[];
}

// [key, label, default, supervisorName?] — default MUST match the daemon's
// real read site (all false). supervisorName links a flag to its live handle
// in the channel-daemon supervisor so the response can carry `running`.
const DAEMON_FLAGS: readonly (readonly [string, string, boolean, string?])[] = [
  ["MUSE_EPISODIC_MEMORY_ENABLED", "Episodic memory capture", false],
  ["MUSE_HOME_WATCH_ENABLED", "Home Assistant watch daemon", false],
  ["MUSE_CONFLICT_WATCH_ENABLED", "Calendar conflict watch", false],
  ["MUSE_PROACTIVE_AGENT_TURN", "Proactive agent turn", false],
  ["MUSE_BACKGROUND_REVIEW_ENABLED", "Background review (skill learning)", false],
  ["MUSE_KNOWLEDGE_SEARCH_ENABLED", "Knowledge search", false],
  ["MUSE_TELEGRAM_POLL_ENABLED", "Telegram inbound polling", false, "telegram-poll"],
  ["MUSE_MATRIX_POLL_ENABLED", "Matrix inbound sync", false, "matrix-sync"],
  ["MUSE_INBOUND_REPLY_ENABLED", "Channel auto-reply (chat as a Muse session)", false, "inbound-reply"]
];

export type DaemonStatusSource = () => Readonly<Record<string, {
  readonly running: boolean;
  readonly lastIngestAtIso?: string;
  readonly lastError?: string;
  readonly lastErrorAtIso?: string;
}>>;

export function shapeDaemonFlags(
  env: NodeJS.ProcessEnv,
  daemonStatus?: DaemonStatusSource,
  settings: DaemonSettings = {}
): DaemonFlagsResponse {
  const status = daemonStatus?.();
  return {
    flags: DAEMON_FLAGS.map(([key, label, dflt, supervisorName]) => ({
      key,
      label,
      enabled: settings[key] ?? parseBoolean(env[key], dflt),
      ...(status && supervisorName ? { running: status[supervisorName]?.running ?? false } : {}),
      ...(status?.[supervisorName ?? ""]?.lastIngestAtIso ? { lastIngestAtIso: status[supervisorName ?? ""]?.lastIngestAtIso } : {}),
      ...(status?.[supervisorName ?? ""]?.lastError ? { lastError: status[supervisorName ?? ""]?.lastError } : {}),
      ...(status?.[supervisorName ?? ""]?.lastErrorAtIso ? { lastErrorAtIso: status[supervisorName ?? ""]?.lastErrorAtIso } : {})
    }))
  };
}

export interface QuietHoursSettingsResponse {
  /** The PERSISTED enable flag (independent of any env var currently winning). */
  readonly enabled: boolean;
  /** The PERSISTED range string, raw (may be an invalid/empty range the user hasn't fixed yet). */
  readonly range: string | undefined;
  /** The range actually in force right now, "HH:MM-HH:MM" — undefined when nothing applies. */
  readonly effectiveRange: string | undefined;
  /** Where `effectiveRange` came from — `env` wins over the persisted setting (see `resolveEffectiveQuietHours`). */
  readonly source: "env" | "persisted" | "none";
}

/**
 * `MUSE_REMINDER_QUIET_HOURS` is the one global env var this SETTINGS surface
 * reflects (per-loop overrides like `MUSE_AMBIENT_QUIET_HOURS` are real but
 * out of scope for a single global toggle — R3-4 "out of scope"). Mirrors
 * `resolveEffectiveQuietHours`'s precedence (env, then persisted) without
 * importing the tick-daemons resolver closures, which this route has no use for.
 */
export function shapeQuietHoursSettings(env: NodeJS.ProcessEnv, settingsFile: string | undefined): QuietHoursSettingsResponse {
  const envRaw = env.MUSE_REMINDER_QUIET_HOURS?.trim();
  const persisted = settingsFile ? readQuietHoursSettingSync(settingsFile) : undefined;
  if (envRaw && parseQuietHours(envRaw)) {
    return { effectiveRange: envRaw, enabled: persisted?.enabled ?? false, range: persisted?.range, source: "env" };
  }
  if (persisted?.enabled && parseQuietHours(persisted.range)) {
    return { effectiveRange: persisted.range, enabled: true, range: persisted.range, source: "persisted" };
  }
  return { effectiveRange: undefined, enabled: persisted?.enabled ?? false, range: persisted?.range, source: "none" };
}

export interface SettingsRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly daemonStatus?: DaemonStatusSource;
  /** Where PATCHed toggles persist; enables the PATCH route when set. */
  readonly daemonSettingsFile?: string;
  /** Applies a toggle to the RUNNING process (start/stop the daemon); returns whether it took effect live. */
  readonly applyDaemonToggle?: (key: string, enabled: boolean) => boolean;
}

export function registerSettingsRoutes(server: FastifyInstance, gate: SettingsRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  server.get("/api/settings/daemon-flags", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    return shapeDaemonFlags(
      process.env,
      gate.daemonStatus,
      gate.daemonSettingsFile ? readDaemonSettingsSync(gate.daemonSettingsFile) : {}
    );
  });

  if (gate.daemonSettingsFile) {
    const settingsFile = gate.daemonSettingsFile;
    server.patch("/api/settings/daemon-flags", async (request, reply) => {
      if (!authed(request, reply)) {
        return reply;
      }
      const body = toBody(request.body);
      const key = typeof body.key === "string" ? body.key : "";
      if (!DAEMON_FLAGS.some(([known]) => known === key)) {
        return reply.status(404).send({ reason: `unknown daemon flag "${key}"` });
      }
      if (typeof body.enabled !== "boolean") {
        return reply.status(400).send({ reason: "enabled must be a boolean" });
      }
      await writeDaemonSetting(settingsFile, key, body.enabled);
      const appliedLive = gate.applyDaemonToggle?.(key, body.enabled) ?? false;
      return { appliedLive, enabled: body.enabled, key };
    });
  }

  server.get("/api/settings/quiet-hours", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    return shapeQuietHoursSettings(process.env, gate.daemonSettingsFile);
  });

  if (gate.daemonSettingsFile) {
    const settingsFile = gate.daemonSettingsFile;
    server.patch("/api/settings/quiet-hours", async (request, reply) => {
      if (!authed(request, reply)) {
        return reply;
      }
      const body = toBody(request.body);
      if (typeof body.enabled !== "boolean") {
        return reply.status(400).send({ reason: "enabled must be a boolean" });
      }
      const range = typeof body.range === "string" ? body.range.trim() : "";
      if (!parseQuietHours(range)) {
        return reply.status(400).send({ reason: `invalid quiet-hours range "${range}" — expected "HH:MM-HH:MM"` });
      }
      await writeQuietHoursSetting(settingsFile, { enabled: body.enabled, range });
      return shapeQuietHoursSettings(process.env, settingsFile);
    });
  }
}
