/**
 * `muse specs` command group, extracted from
 * apps/cli/src/program.ts.
 *
 * Self-contained: only consumes the `apiRequest` / `writeOutput`
 * helpers (passed in as dependencies). Wraps the agent-spec
 * registry endpoints (list / get / resolve) in commander
 * argument-parsing.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface SpecsHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerSpecsCommands(program: Command, io: ProgramIO, helpers: SpecsHelpers): void {
  const { apiRequest, writeOutput } = helpers;
  const specs = program.command("specs").description("List, inspect, and resolve agent specs");

  specs
    .command("list")
    .description("List all registered agent specs")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/agent-specs"));
    });

  specs
    .command("get")
    .description("Fetch a single agent spec by name")
    .argument("<name>", "Agent spec name")
    .action(async (name: string, _options, command) => {
      writeOutput(io, await apiRequest(io, command, `/agent-specs/${encodeURIComponent(name)}`));
    });

  specs
    .command("resolve")
    .description("Resolve which agent spec matches a user prompt")
    .argument("<text...>", "User prompt to route")
    .action(async (textParts: readonly string[], _options, command) => {
      const text = textParts.join(" ").trim();
      if (text.length === 0) {
        throw new Error("specs resolve requires a non-empty prompt");
      }
      writeOutput(io, await apiRequest(io, command, "/agent-specs/resolve", { text }));
    });
}
