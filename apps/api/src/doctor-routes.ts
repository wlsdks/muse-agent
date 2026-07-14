import { readInbox, readReplyCursor } from "@muse/messaging";

import { computeDoctorChecks, DOCTOR_FIXES, type DoctorCheck } from "./doctor-checks.js";
import { readDaemonSettingsSync, writeDaemonSetting } from "./daemon-settings-store.js";
import { serverBuildId, serverStartedAtIso } from "./build-info.js";
import { requireAuthenticated } from "./server-helpers.js";
import { toBody } from "./compat-parsers.js";
import { shapeDaemonFlags, type DaemonStatusSource } from "./settings-routes.js";

import type { FastifyInstance } from "fastify";
import type { ServerOptions } from "./server.js";

/**
 * `/api/doctor` — the web console's one-click "진단 & 수리" surface.
 * GET returns deterministic checks (daemon consistency, poll conflicts,
 * Ollama reachability, reply backlog); POST /fix applies ONLY the
 * allowlisted daemon-flag fixes through the same persist+live seam the
 * settings PATCH uses. POST /api/admin/shutdown lets the desktop app
 * replace a stale server (loopback-only; exits via the graceful SIGTERM
 * path so in-flight work drains).
 */

const PROBE_CHANNELS = ["telegram", "matrix", "discord", "slack", "line"] as const;

export interface DoctorRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly daemonStatus?: DaemonStatusSource;
  readonly daemonSettingsFile?: string;
  readonly applyDaemonToggle?: (key: string, enabled: boolean) => boolean;
  readonly messaging?: { readonly has: (id: string) => boolean };
  readonly telegramInboxFile?: string;
}

export interface DoctorResponse {
  readonly version: string;
  readonly pid: number;
  readonly startedAtIso: string;
  readonly checks: readonly DoctorCheck[];
}

async function probeOllama(env: NodeJS.ProcessEnv): Promise<boolean> {
  const base = env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
  try {
    const response = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function countUnreplied(inboxFile: string, limit = 200): Promise<number> {
  try {
    const [messages, handled] = await Promise.all([
      readInbox(inboxFile, limit),
      readReplyCursor(`${inboxFile}.reply-cursor.json`)
    ]);
    const handledSet = new Set(handled);
    return messages.filter((m) => !handledSet.has(`${m.providerId}:${m.messageId}`)).length;
  } catch {
    return 0;
  }
}

function isLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function registerDoctorRoutes(server: FastifyInstance, gate: DoctorRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  server.get("/api/doctor", async (request, reply): Promise<DoctorResponse | typeof reply> => {
    if (!authed(request, reply)) {
      return reply;
    }
    const flagsResponse = shapeDaemonFlags(
      process.env,
      gate.daemonStatus,
      gate.daemonSettingsFile ? readDaemonSettingsSync(gate.daemonSettingsFile) : {}
    );
    const connectedChannels = PROBE_CHANNELS.filter((id) => gate.messaging?.has(id) ?? false);
    const [ollamaReachable, unrepliedCount] = await Promise.all([
      probeOllama(process.env),
      gate.telegramInboxFile ? countUnreplied(gate.telegramInboxFile) : 0
    ]);
    return {
      checks: computeDoctorChecks({
        connectedChannels,
        flags: flagsResponse.flags,
        nowIso: new Date().toISOString(),
        ollamaReachable,
        unrepliedCount
      }),
      pid: process.pid,
      startedAtIso: serverStartedAtIso(),
      version: serverBuildId()
    };
  });

  if (gate.daemonSettingsFile) {
    const settingsFile = gate.daemonSettingsFile;
    server.post("/api/doctor/fix", async (request, reply) => {
      if (!authed(request, reply)) {
        return reply;
      }
      const body = toBody(request.body);
      const fixId = typeof body.id === "string" ? body.id : "";
      const flagKey = DOCTOR_FIXES[fixId];
      if (!flagKey) {
        return reply.status(404).send({ reason: `unknown fix "${fixId}"` });
      }
      await writeDaemonSetting(settingsFile, flagKey, true);
      const appliedLive = gate.applyDaemonToggle?.(flagKey, true) ?? false;
      return { appliedLive, fixId, flagKey };
    });
  }

  // The desktop app calls this when the answering server's build id does
  // not match its bundled binary (a stale instance holding the port).
  // Loopback-only: this server binds 127.0.0.1, but never trust that alone.
  server.post("/api/admin/shutdown", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    if (!isLoopback(request.ip)) {
      return reply.status(403).send({ reason: "shutdown is loopback-only" });
    }
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 250).unref();
    return { shuttingDown: true, version: serverBuildId() };
  });
}
