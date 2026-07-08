import { homedir } from "node:os";
import path from "node:path";

import type { Command } from "commander";

import { runFirstRunSetupInteractive } from "./first-run.js";
import { configPath, readConfigStore, writeConfigStore } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

/**
 * `muse setup start` — launch the SAME first-run "how should Muse think?"
 * picker on demand (Local / Cloud / Codex), independent of the once-only
 * auto-launch guard. Reuses the shared wizard so on-demand and first-run stay
 * identical. Attaches to the already-registered `setup` command group, so the
 * setup loader must register the setup root before calling this.
 */
export function registerSetupStartSubcommand(program: Command, io: ProgramIO, _deps?: unknown): void {
  const setupRoot = program.commands.find((cmd) => cmd.name() === "setup");
  if (!setupRoot) {
    throw new Error("registerSetupStartSubcommand: 'setup' command group must be registered first.");
  }
  setupRoot
    .command("start")
    .description("Pick how Muse thinks (Local / Cloud API key / Codex) — the friendly first-run wizard, on demand")
    .action(async () => {
      const home = io.configDir ? path.dirname(configPath(io)) : homedir();
      await runFirstRunSetupInteractive({
        home,
        readConfig: () => readConfigStore(io),
        writeConfig: (config) => writeConfigStore(io, config),
        ...(io.fetch ? { fetch: io.fetch } : {})
      });
    });
}
