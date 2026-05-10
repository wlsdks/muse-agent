/**
 * `muse notes` command group — last leg of the personal-domain CLI
 * trio. Wraps `/api/notes/*` for remote mode and the in-process
 * `createNotesMcpServer` (same engine the API uses) for `--local`
 * mode so the CLI works without an API server.
 *
 * Five subcommands match the underlying tool surface:
 *   - `muse notes list [--subdir <path>]`
 *   - `muse notes read <path>`
 *   - `muse notes search <query...> [--limit <n>]`
 *   - `muse notes save <path> <content...> [--overwrite]`
 *   - `muse notes append <path> <content...>`
 */

import { resolveNotesDir } from "@muse/autoconfigure";
import { createNotesMcpServer } from "@muse/mcp";
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

interface LocalOption {
  readonly local?: boolean;
}

async function callLocalTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
  const server = createNotesMcpServer({ notesDir });
  const tool = server.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`local notes tool not found: ${name}`);
  }
  const raw = await tool.execute(args as Parameters<typeof tool.execute>[0]);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const result = raw as Record<string, unknown>;
    if (typeof result.error === "string") {
      throw new Error(result.error);
    }
    return result;
  }
  return { result: raw };
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
    .description("List notes directory entries (--local skips the API)")
    .option("--subdir <path>", "Subdirectory relative to the notes root")
    .option("--local", "Read directly from the local notes directory instead of the API")
    .action(async (options: { readonly subdir?: string } & LocalOption, command) => {
      if (options.local) {
        const args: Record<string, unknown> = options.subdir ? { subdir: options.subdir } : {};
        helpers.writeOutput(io, await callLocalTool("list", args));
        return;
      }
      const path = options.subdir
        ? `/api/notes/list?subdir=${encodeURIComponent(options.subdir)}`
        : "/api/notes/list";
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  notes
    .command("read")
    .description("Read a note as UTF-8 (--local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .option("--local", "Read directly from the local notes directory instead of the API")
    .action(async (notePath: string, options: LocalOption, command) => {
      if (options.local) {
        helpers.writeOutput(io, await callLocalTool("read", { path: notePath }));
        return;
      }
      const url = `/api/notes/read?path=${encodeURIComponent(notePath)}`;
      helpers.writeOutput(io, await helpers.apiRequest(io, command, url));
    });

  notes
    .command("search")
    .description("Substring search across .md files (--local skips the API)")
    .argument("<query...>", "Substring to grep for (joined by spaces)")
    .option("--limit <n>", "Max matches (default 20)")
    .option("--local", "Search the local notes directory instead of the API")
    .action(async (
      queryParts: readonly string[],
      options: { readonly limit?: string } & LocalOption,
      command
    ) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        throw new Error("query is required");
      }
      if (options.local) {
        const args: Record<string, unknown> = { query };
        if (options.limit && options.limit.length > 0) {
          const parsed = Number(options.limit);
          if (Number.isFinite(parsed)) {
            args.limit = parsed;
          }
        }
        helpers.writeOutput(io, await callLocalTool("search", args));
        return;
      }
      const params = new URLSearchParams({ query });
      if (options.limit && options.limit.length > 0) {
        params.set("limit", options.limit);
      }
      helpers.writeOutput(io, await helpers.apiRequest(io, command, `/api/notes/search?${params.toString()}`));
    });

  notes
    .command("save")
    .description("Write a note (refuses to clobber unless --overwrite; --local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .argument("<content...>", "UTF-8 file contents (joined by spaces)")
    .option("--overwrite", "Replace an existing note in place")
    .option("--local", "Write directly to the local notes directory instead of the API")
    .action(async (
      notePath: string,
      contentParts: readonly string[],
      options: { readonly overwrite?: boolean } & LocalOption,
      command
    ) => {
      const content = contentParts.join(" ");
      if (options.local) {
        const args: Record<string, unknown> = { content, path: notePath };
        if (options.overwrite === true) {
          args.overwrite = true;
        }
        helpers.writeOutput(io, await callLocalTool("save", args));
        return;
      }
      const body: Record<string, unknown> = { content, path: notePath };
      if (options.overwrite === true) {
        body.overwrite = true;
      }
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/notes/save", body, "POST"));
    });

  notes
    .command("append")
    .description("Tail-append to a note (creates if missing; --local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .argument("<content...>", "UTF-8 text to append (joined by spaces)")
    .option("--local", "Append directly in the local notes directory instead of the API")
    .action(async (
      notePath: string,
      contentParts: readonly string[],
      options: LocalOption,
      command
    ) => {
      const content = contentParts.join(" ");
      if (options.local) {
        helpers.writeOutput(io, await callLocalTool("append", { content, path: notePath }));
        return;
      }
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/notes/append", { content, path: notePath }, "POST"));
    });
}
