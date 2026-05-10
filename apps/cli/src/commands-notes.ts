/**
 * `muse notes` command group — last leg of the personal-domain CLI
 * trio (calendar at round 109, tasks at round 110, notes this iter).
 *
 * Wraps `/api/notes/*` (REST surface added in round 111). Five
 * subcommands matching the underlying tool surface:
 *   - `muse notes list [--subdir <path>]`
 *   - `muse notes read <path>`
 *   - `muse notes search <query...> [--limit <n>]`
 *   - `muse notes save <path> <content...> [--overwrite]`
 *   - `muse notes append <path> <content...>`
 *
 * Same DI injection pattern as calendar / tasks / memory / voice —
 * helpers come in via `program.ts` so the command module stays
 * stateless.
 *
 * The agent's MCP `muse.notes.*` tools and the same routes coexist;
 * this CLI is purely an additional terminal-friendly surface.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface NotesCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerNotesCommands(program: Command, io: ProgramIO, helpers: NotesCommandHelpers): void {
  const notes = program.command("notes").description("Personal notes (filesystem-backed)");

  notes
    .command("providers")
    .description("GET /api/notes/providers — list configured notes backends")
    .action(async (_options, command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/notes/providers"));
    });

  notes
    .command("list")
    .description("GET /api/notes/list — directory entries")
    .option("--subdir <path>", "Subdirectory relative to the notes root")
    .action(async (options: { readonly subdir?: string }, command) => {
      const path = options.subdir
        ? `/api/notes/list?subdir=${encodeURIComponent(options.subdir)}`
        : "/api/notes/list";
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  notes
    .command("read")
    .description("GET /api/notes/read — read a note as UTF-8")
    .argument("<path>", "Note path relative to the notes root")
    .action(async (notePath: string, _options, command) => {
      const url = `/api/notes/read?path=${encodeURIComponent(notePath)}`;
      helpers.writeOutput(io, await helpers.apiRequest(io, command, url));
    });

  notes
    .command("search")
    .description("GET /api/notes/search — substring search across .md files")
    .argument("<query...>", "Substring to grep for (joined by spaces)")
    .option("--limit <n>", "Max matches (default 20)")
    .action(async (queryParts: readonly string[], options: { readonly limit?: string }, command) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        throw new Error("query is required");
      }
      const params = new URLSearchParams({ query });
      if (options.limit && options.limit.length > 0) {
        params.set("limit", options.limit);
      }
      helpers.writeOutput(io, await helpers.apiRequest(io, command, `/api/notes/search?${params.toString()}`));
    });

  notes
    .command("save")
    .description("POST /api/notes/save — write a note (refuses to clobber unless --overwrite)")
    .argument("<path>", "Note path relative to the notes root")
    .argument("<content...>", "UTF-8 file contents (joined by spaces)")
    .option("--overwrite", "Replace an existing note in place")
    .action(async (
      notePath: string,
      contentParts: readonly string[],
      options: { readonly overwrite?: boolean },
      command
    ) => {
      const content = contentParts.join(" ");
      const body: Record<string, unknown> = { content, path: notePath };
      if (options.overwrite === true) {
        body.overwrite = true;
      }
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/notes/save", body, "POST"));
    });

  notes
    .command("append")
    .description("POST /api/notes/append — tail-append to an existing note (creates if missing)")
    .argument("<path>", "Note path relative to the notes root")
    .argument("<content...>", "UTF-8 text to append (joined by spaces)")
    .action(async (notePath: string, contentParts: readonly string[], _options, command) => {
      const content = contentParts.join(" ");
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/notes/append", { content, path: notePath }, "POST"));
    });
}
