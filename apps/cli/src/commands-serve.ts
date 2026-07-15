/**
 * `muse serve` — run the Muse API server as one command instead of the
 * `pnpm --filter @muse/api dev` incantation. Foreground by default (logs
 * stream, ctrl-c stops it); `--install` keeps it always-on via a macOS
 * LaunchAgent (mirrors `muse daemon --install`, separate service:
 * `com.muse.api`). Never spawns a second server on a healthy same-build
 * port, never shuts one down without --replace — see commands-serve-core.ts
 * for the pure decision logic and commands-serve-launchagent.ts for the
 * autostart wiring.
 */

import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { errorMessage } from "@muse/shared";

import { discoverRepoRoot, isGitRepo } from "./commands-update.js";
import {
  decideServeAction,
  defaultServeFetch,
  defaultServeSpawn,
  hostForProbe,
  probeServeHealth,
  probeWebUi,
  resolveServeHost,
  resolveServePort,
  resolveServeWebDir,
  runServeForeground,
  shutdownAndWaitFree,
  type ServeSpawnFn
} from "./commands-serve-core.js";
import { installApiAutostart, resolveApiLaunchAgentFile, API_LAUNCH_AGENT_LABEL, defaultRunLaunchctl } from "./commands-serve-launchagent.js";
import { t } from "./cli-i18n.js";
import { readApiOptions } from "./program-config.js";
import type { ProgramIO } from "./program.js";

export interface ServeHelpers {
  /** Test seam — defaults to `process.argv[1]`. */
  readonly entry?: string;
  readonly existsSync?: (path: string) => boolean;
  readonly realpathSync?: (path: string) => string;
  readonly env?: () => NodeJS.ProcessEnv;
  /** Test seam — inject the spawn used for the foreground server child. */
  readonly spawn?: ServeSpawnFn;
  /** Test seam — inject SIGINT/SIGTERM registration instead of the real `process.on`. */
  readonly registerSignalHandler?: (event: "SIGINT" | "SIGTERM", handler: () => void) => void;
  /** Test seam — inject `sleep` for the port-freed poll after --replace. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — platform override for the --install/--uninstall/--status branches. */
  readonly platform?: NodeJS.Platform;
  /** Test seam — runs `launchctl` with an argv array; never real launchctl under vitest. */
  readonly runLaunchctl?: (args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

export function registerServeCommand(program: Command, io: ProgramIO, helpers: ServeHelpers = {}): void {
  program
    .command("serve")
    .description("Run the Muse API server — the one command that starts it (foreground); --install keeps it always-on")
    .option("--replace", "Shut down a different-build server already on the port before starting (loopback-only, version-gated)")
    .option("--port <port>", "Port to bind (default: PORT env, else 3030)")
    .option("--host <host>", "Host to bind (default: HOST env, else 127.0.0.1)")
    .option("--install", "Write a macOS LaunchAgent plist AND load it via launchctl so the API server survives logout/reboot, then exit")
    .option("--uninstall", "Unload the macOS LaunchAgent and delete its file, then exit")
    .option("--status", "Print whether the API server is running + whether autostart is installed, then exit")
    .action(async (options: {
      readonly replace?: boolean;
      readonly port?: string;
      readonly host?: string;
      readonly install?: boolean;
      readonly uninstall?: boolean;
      readonly status?: boolean;
    }, command: Command) => {
      const e = helpers.env?.() ?? process.env;
      const fetchImpl = io.fetch ?? defaultServeFetch;
      const exists = helpers.existsSync ?? existsSync;
      const resolveRealPath = helpers.realpathSync ?? realpathSync;

      const port = resolveServePort(options.port ?? e.PORT);
      const host = resolveServeHost(options.host ?? e.HOST);
      const probeHost = hostForProbe(host);
      const baseUrl = `http://${probeHost}:${String(port)}`;
      const healthUrl = `${baseUrl}/health`;

      const resolveDistEntry = (): { readonly repoRoot: string; readonly distEntry: string } | undefined => {
        const repoRoot = discoverRepoRoot(helpers.entry ?? process.argv[1], exists, resolveRealPath);
        if (!repoRoot || !isGitRepo(repoRoot, exists)) {
          io.stderr(t("serve.notGitCheckout"));
          return undefined;
        }
        const distEntry = join(repoRoot, "apps", "api", "dist", "index.js");
        if (!exists(distEntry)) {
          io.stderr(t("serve.distMissing", { repoRoot }));
          return undefined;
        }
        return { distEntry, repoRoot };
      };

      if (options.install) {
        const located = resolveDistEntry();
        if (!located) {
          process.exitCode = 1;
          return;
        }
        const result = await installApiAutostart(io, e, {
          distEntry: located.distEntry,
          existsSync: exists,
          host,
          port,
          repoRoot: located.repoRoot,
          ...(helpers.platform ? { platform: helpers.platform } : {}),
          ...(helpers.runLaunchctl ? { runLaunchctl: helpers.runLaunchctl } : {})
        });
        if (!result.ok) process.exitCode = 1;
        return;
      }

      if (options.uninstall) {
        const plat = helpers.platform ?? process.platform;
        if (plat !== "darwin") {
          io.stderr(t("serve.install.platformUnsupported", { platform: plat }));
          process.exitCode = 1;
          return;
        }
        const plistFile = resolveApiLaunchAgentFile(e);
        if (!exists(plistFile)) {
          io.stdout(t("serve.uninstall.notInstalled", { plistFile }));
          return;
        }
        const runLaunchctl = helpers.runLaunchctl ?? defaultRunLaunchctl;
        await runLaunchctl(["unload", "-w", plistFile]);
        const listResult = await runLaunchctl(["list", API_LAUNCH_AGENT_LABEL]);
        if (listResult.code === 0) {
          io.stderr(t("serve.uninstall.stillRegistered", { label: API_LAUNCH_AGENT_LABEL, plistFile }));
          process.exitCode = 1;
          return;
        }
        try {
          rmSync(plistFile);
        } catch (cause) {
          io.stderr(t("serve.uninstall.removeFailed", { detail: errorMessage(cause), plistFile }));
          process.exitCode = 1;
          return;
        }
        io.stdout(t("serve.uninstall.removed", { plistFile }));
        return;
      }

      if (options.status) {
        const probe = await probeServeHealth(fetchImpl, healthUrl);
        io.stdout(probe.kind === "healthy"
          ? t("serve.status.running", { host: probeHost, pid: String(probe.pid), port: String(port), startedAtIso: probe.startedAtIso, version: probe.version })
          : t("serve.status.notRunning", { host: probeHost, port: String(port) }));
        if (probe.kind === "healthy") {
          const webUi = await probeWebUi(fetchImpl, baseUrl);
          io.stdout(webUi === "serving"
            ? t("serve.status.webUi.serving", { host: probeHost, port: String(port) })
            : webUi === "not-serving"
              ? t("serve.status.webUi.notServing")
              : t("serve.status.webUi.unknown"));
        }
        const plat = helpers.platform ?? process.platform;
        if (plat === "darwin") {
          const plistFile = resolveApiLaunchAgentFile(e);
          io.stdout(exists(plistFile)
            ? t("serve.status.autostartInstalled", { plistFile })
            : t("serve.status.autostartNotInstalled"));
        } else {
          io.stdout(t("serve.status.autostartUnsupportedPlatform", { platform: plat }));
        }
        return;
      }

      const located = resolveDistEntry();
      if (!located) {
        process.exitCode = 1;
        return;
      }

      const probe = await probeServeHealth(fetchImpl, healthUrl);
      const plannedBuildId = e.MUSE_BUILD_ID?.trim() || "dev";
      const decision = decideServeAction(probe, plannedBuildId, Boolean(options.replace));

      if (decision.action === "already-running") {
        io.stdout(t("serve.alreadyRunning", {
          host: probeHost,
          pid: String(decision.payload.pid),
          port: String(port),
          startedAtIso: decision.payload.startedAtIso,
          version: decision.payload.version
        }));
        if (decision.bothDev) io.stdout(t("serve.alreadyRunning.devVsDevNote"));
        return;
      }
      if (decision.action === "fail-non-muse") {
        io.stderr(t("serve.foundNonMuse", { detail: decision.detail, host: probeHost, port: String(port) }));
        process.exitCode = 1;
        return;
      }
      if (decision.action === "offer-replace") {
        io.stderr(t("serve.foundDifferentBuild", { detail: decision.detail, host: probeHost, port: String(port) }));
        process.exitCode = 1;
        return;
      }
      if (decision.action === "replace") {
        io.stdout(t("serve.replacing", { host: probeHost, port: String(port) }));
        const { token } = await readApiOptions(io, command, { includeStoredToken: false });
        const replaced = await shutdownAndWaitFree(fetchImpl, baseUrl, healthUrl, {
          ...(helpers.sleep ? { sleep: helpers.sleep } : {}),
          ...(token ? { token } : {})
        });
        if (!replaced.ok) {
          io.stderr(t("serve.replaceShutdownFailed", { detail: replaced.detail ?? "unknown error" }));
          process.exitCode = 1;
          return;
        }
      }

      const webDirResolution = resolveServeWebDir(e, located.repoRoot, exists);
      if (webDirResolution.builtInMissing) io.stdout(t("serve.webDirMissing", { repoRoot: located.repoRoot }));

      io.stdout(t("serve.starting", { host: probeHost, port: String(port), repoRoot: located.repoRoot }));
      const exitCode = await runServeForeground({
        args: [located.distEntry],
        command: process.execPath,
        cwd: located.repoRoot,
        env: { ...e, HOST: host, PORT: String(port), ...(webDirResolution.webDir ? { MUSE_WEB_DIR: webDirResolution.webDir } : {}) },
        ...(helpers.registerSignalHandler ? { registerSignalHandler: helpers.registerSignalHandler } : {}),
        spawn: helpers.spawn ?? defaultServeSpawn,
        stdout: io.stdout
      });
      if (exitCode !== 0) {
        io.stdout(t("serve.exited", { code: String(exitCode) }));
        process.exitCode = exitCode;
      }
    });
}
