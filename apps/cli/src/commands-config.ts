/**
 * `muse config` command group, extracted from apps/cli/src/program.ts.
 *
 * Self-contained: only consumes the existing `readConfigStore` /
 * `writeConfigStore` / `setConfigValue` helpers (passed in as
 * dependencies) and `writeOutput`. Wraps the CLI config show / set
 * surface in commander argument-parsing. Same DI pattern as the
 * scheduler / orchestrate / mcp / specs extractions.
 *
 * `MuseCliConfig` and the read/write helpers stay defined in
 * program.ts because they're shared with `tui`, `chat`, and
 * `readApiOptions`. This module only owns the command surface.
 */

import type { ActuatorMode } from "@muse/autoconfigure";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface MuseCliConfigShape {
  readonly apiUrl?: string;
  readonly defaultModel?: string;
  readonly actuators?: { readonly mode: ActuatorMode };
}

export interface ConfigCommandHelpers {
  readonly readConfigStore: (io: ProgramIO) => Promise<MuseCliConfigShape>;
  readonly writeConfigStore: (io: ProgramIO, config: MuseCliConfigShape) => Promise<void>;
  readonly setConfigValue: (config: MuseCliConfigShape, key: string, value: string) => MuseCliConfigShape;
  readonly unsetConfigValue: (config: MuseCliConfigShape, key: string) => { readonly config: MuseCliConfigShape; readonly wasSet: boolean };
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerConfigCommands(program: Command, io: ProgramIO, helpers: ConfigCommandHelpers): void {
  const config = program.command("config").description("Manage CLI config");

  config
    .command("show")
    .description("Show CLI config")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { readonly json?: boolean }) => {
      const store = await helpers.readConfigStore(io);

      if (options.json) {
        helpers.writeOutput(io, store);
        return;
      }

      io.stdout(`apiUrl=${store.apiUrl ?? ""}\n`);
      io.stdout(`defaultModel=${store.defaultModel ?? ""}\n`);
      // Show the EFFECTIVE default rather than a blank when unset — an empty
      // value here would read as "no policy", when the real policy is `off`.
      io.stdout(`actuators.mode=${store.actuators?.mode ?? "off"}\n`);
    });

  config
    .command("set")
    .description("Set a CLI config value")
    .argument("<key>", "Config key: apiUrl, defaultModel, language (ko/en), or actuators.mode (off|ask|auto)")
    .argument("<value>", "Config value")
    .option("--json", "Emit a structured payload instead of the human-readable confirmation")
    .action(async (key: string, value: string, options: { readonly json?: boolean }) => {
      const current = await helpers.readConfigStore(io);
      const next = helpers.setConfigValue(current, key, value);
      await helpers.writeConfigStore(io, next);
      if (options.json) {
        io.stdout(`${JSON.stringify({ key, value: value.trim() }, null, 2)}\n`);
        return;
      }
      io.stdout(`Set ${key}\n`);
    });

  config
    .command("unset")
    .description("Clear a CLI config value (reverts to the built-in default)")
    .argument("<key>", "Config key: apiUrl, defaultModel, language (ko/en), or actuators.mode (off|ask|auto)")
    .option("--json", "Emit a structured payload instead of the human-readable confirmation")
    .action(async (key: string, options: { readonly json?: boolean }) => {
      const current = await helpers.readConfigStore(io);
      const { config: next, wasSet } = helpers.unsetConfigValue(current, key);
      await helpers.writeConfigStore(io, next);
      if (options.json) {
        io.stdout(`${JSON.stringify({ key, wasSet }, null, 2)}\n`);
        return;
      }
      io.stdout(wasSet ? `Unset ${key}\n` : `${key} was not set\n`);
    });
}
