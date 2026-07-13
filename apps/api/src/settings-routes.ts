import { parseBoolean } from "@muse/autoconfigure";

import { readDaemonSettingsSync, writeDaemonSetting, type DaemonSettings } from "./daemon-settings-store.js";
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
      const body = (request.body ?? {}) as { key?: string; enabled?: boolean };
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
}
