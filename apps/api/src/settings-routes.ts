import { parseBoolean } from "@muse/autoconfigure";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface DaemonFlagView {
  readonly key: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface DaemonFlagsResponse {
  readonly flags: readonly DaemonFlagView[];
}

// [key, label, default] — default MUST match the daemon's real read site (all false).
const DAEMON_FLAGS: readonly (readonly [string, string, boolean])[] = [
  ["MUSE_EPISODIC_MEMORY_ENABLED", "Episodic memory capture", false],
  ["MUSE_HOME_WATCH_ENABLED", "Home-folder watch daemon", false],
  ["MUSE_CONFLICT_WATCH_ENABLED", "Calendar conflict watch", false],
  ["MUSE_PROACTIVE_AGENT_TURN", "Proactive agent turn", false],
  ["MUSE_BACKGROUND_REVIEW_ENABLED", "Background review (skill learning)", false],
  ["MUSE_KNOWLEDGE_SEARCH_ENABLED", "Knowledge search", false]
];

export function shapeDaemonFlags(env: NodeJS.ProcessEnv): DaemonFlagsResponse {
  return {
    flags: DAEMON_FLAGS.map(([key, label, dflt]) => ({
      key,
      label,
      enabled: parseBoolean(env[key], dflt)
    }))
  };
}

export interface SettingsRoutesGate {
  readonly authService: ServerOptions["authService"];
}

export function registerSettingsRoutes(server: FastifyInstance, gate: SettingsRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  server.get("/api/settings/daemon-flags", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    return shapeDaemonFlags(process.env);
  });
}
