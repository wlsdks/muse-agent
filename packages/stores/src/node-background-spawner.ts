/**
 * X-3 (slice 4) — the concrete OS spawner behind the injectable
 * {@link BackgroundSpawner} seam. Launches the command DETACHED (survives
 * the parent turn/process) with stdout+stderr appended to a log file the
 * registry records, and `unref`s it so Muse can exit while it keeps running.
 * Shell form so "npm run dev"-style command lines work; the catastrophic-
 * command guard runs BEFORE this (slice 2's injected classifier), and a
 * background launch is execute-risk like run_command.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import type { BackgroundSpawner, SpawnedChild } from "./background-process-spawn.js";

export function createNodeBackgroundSpawner(): BackgroundSpawner {
  return {
    spawn(command, options): SpawnedChild {
      mkdirSync(dirname(options.logFile), { recursive: true });
      const fd = openSync(options.logFile, "a");
      try {
        const child = spawn(command, {
          shell: true,
          detached: true,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          stdio: ["ignore", fd, fd]
        });
        child.unref();
        return {
          pid: child.pid ?? -1,
          onExit(listener) {
            child.on("exit", (code) => {
              void listener(code);
            });
          }
        };
      } finally {
        // The child has inherited the fd; the parent's copy is no longer needed.
        closeSync(fd);
      }
    }
  };
}
