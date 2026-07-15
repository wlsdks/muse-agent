/**
 * `muse settings` command group. Wraps `/api/admin/settings/*` so
 * runtime settings can be inspected and edited from the terminal
 * without curl or the web UI.
 */

import type { Command } from "commander";

import { parseBooleanTriState } from "@muse/autoconfigure";
import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

const SETTING_TYPES = ["string", "number", "boolean", "json"] as const;
type SettingType = (typeof SETTING_TYPES)[number];
const SETTING_TYPES_SET = new Set<string>(SETTING_TYPES);

function isSettingType(raw: string): raw is SettingType {
  return SETTING_TYPES_SET.has(raw);
}

export interface SettingsCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function inferSettingType(value: string): "boolean" | "number" | "json" | "string" {
  const trimmed = value.trim();
  if (parseBooleanTriState(trimmed) !== undefined) {
    return "boolean";
  }
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) {
    return "number";
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // fall through to string
    }
  }
  return "string";
}

export function registerSettingsCommands(program: Command, io: ProgramIO, helpers: SettingsCommandHelpers): void {
  const settings = program.command("settings").description("Inspect and edit runtime settings");

  settings
    .command("list")
    .description("List all runtime settings")
    .action(async (_options, command: Command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/admin/settings"));
    });

  settings
    .command("get")
    .description("Fetch a single setting by key")
    .argument("<key>", "Setting key (e.g. webSearch.enabled)")
    .action(async (key: string, _options, command: Command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/admin/settings/${encodeURIComponent(key)}`)
      );
    });

  settings
    .command("set")
    .description("Set a setting value (type is auto-inferred from the literal)")
    .argument("<key>", "Setting key")
    .argument("<value>", "Setting value (string, number, boolean, or JSON literal)")
    .option("--type <type>", "Override the inferred type (string | number | boolean | json)")
    .option("--category <category>", "Optional category label")
    .action(async (
      key: string,
      value: string,
      options: { readonly type?: string; readonly category?: string },
      command: Command
    ) => {
      let type: SettingType;
      if (options.type !== undefined) {
        const normalized = options.type.trim().toLowerCase();
        if (!isSettingType(normalized)) {
          const suggestion = closestCommandName(normalized, SETTING_TYPES);
          const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
          throw new Error(`--type must be one of string | number | boolean | json (got '${options.type}')${hint}`);
        }
        type = normalized;
      } else {
        type = inferSettingType(value);
      }
      const body: Record<string, unknown> = { type, value };
      if (options.category !== undefined) body.category = options.category;
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/admin/settings/${encodeURIComponent(key)}`, body, "PUT")
      );
    });

  settings
    .command("unset")
    .description("Delete a setting by key")
    .argument("<key>", "Setting key")
    .action(async (key: string, _options, command: Command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/admin/settings/${encodeURIComponent(key)}`, undefined, "DELETE")
      );
    });

  settings
    .command("refresh")
    .description("Trigger a runtime settings refresh (reload from store)")
    .action(async (_options, command: Command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, "/api/admin/settings/refresh", {}, "POST")
      );
    });
}
