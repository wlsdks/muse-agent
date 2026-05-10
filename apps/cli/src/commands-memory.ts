/**
 * `muse memory` command group, extracted-style.
 *
 * Wraps the personal-user-memory CRUD on `/api/user-memory/:userId`:
 *
 *   - `muse memory show` — GET, prints facts / preferences / recentTopics
 *   - `muse memory set <kind> <key> <value>` — PUT a fact or preference
 *     (kind = "fact" | "preference")
 *   - `muse memory clear` — DELETE the user-memory record
 *
 * In personal-use mode (auth disabled) the server accepts any
 * non-`anonymous` userId, so the CLI defaults to `me` and a
 * `--user <userId>` flag can override when running with auth.
 *
 * Same DI injection pattern as the other CLI command modules:
 * helpers come in via the parent `program.ts` so this module stays
 * stateless.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface MemoryCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerMemoryCommands(program: Command, io: ProgramIO, helpers: MemoryCommandHelpers): void {
  const memory = program.command("memory").description("Personal user-memory facts / preferences");

  memory
    .command("show")
    .description("GET /api/user-memory/<user> — print stored facts, preferences, recent topics")
    .option("--user <userId>", "User id to read (default: me)", "me")
    .action(async (options: { readonly user: string }, command) => {
      const path = `/api/user-memory/${encodeURIComponent(options.user)}`;
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  memory
    .command("set")
    .description("PUT /api/user-memory/<user>/{facts|preferences} — store a key/value entry")
    .argument("<kind>", "Entry kind: 'fact' or 'preference'")
    .argument("<key>", "Memory key (e.g. timezone)")
    .argument("<value>", "Memory value")
    .option("--user <userId>", "User id to write (default: me)", "me")
    .action(async (
      kind: string,
      key: string,
      value: string,
      options: { readonly user: string },
      command
    ) => {
      const segment = parseKindSegment(kind);
      const path = `/api/user-memory/${encodeURIComponent(options.user)}/${segment}`;
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path, { key, value }, "PUT"));
    });

  memory
    .command("clear")
    .description("DELETE /api/user-memory/<user> — wipe stored memory for this user")
    .option("--user <userId>", "User id to clear (default: me)", "me")
    .action(async (options: { readonly user: string }, command) => {
      const path = `/api/user-memory/${encodeURIComponent(options.user)}`;
      await helpers.apiRequest(io, command, path, undefined, "DELETE");
      io.stdout(`Cleared user memory for ${options.user}\n`);
    });
}

function parseKindSegment(kind: string): "facts" | "preferences" {
  const trimmed = kind.trim().toLowerCase();
  if (trimmed === "fact" || trimmed === "facts") {
    return "facts";
  }
  if (trimmed === "preference" || trimmed === "preferences") {
    return "preferences";
  }
  throw new Error("kind must be 'fact' or 'preference'");
}
