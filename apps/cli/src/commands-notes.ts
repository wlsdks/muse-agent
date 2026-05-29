/**
 * `muse notes` command group. Wraps `/api/notes/*` for remote mode
 * and the in-process `createNotesMcpServer` (same engine the API
 * uses) for `--local` mode so the CLI works without an API server.
 *
 * Output: human-readable by default; `--json` opts into the raw
 * envelope for scripting.
 */

import { readFile } from "node:fs/promises";

import { resolveNotesDir } from "@muse/autoconfigure";
import { createNotesMcpServer, fetchReadableUrl } from "@muse/mcp";
import type { Command } from "commander";

import {
  formatNoteAppended,
  formatNoteRead,
  formatNoteSaved,
  formatNoteSearch,
  formatNotesList,
  formatProvidersList
} from "./human-formatters.js";
import { isApiUnreachable } from "./program-helpers.js";
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

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
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

// Absent → undefined (let the server/tool use its own default).
// A genuine positive number is truncated; a non-numeric /
// non-positive value rejects rather than being silently dropped
// (NaN) or passed through (0 / negative).
export function parseNotesSearchLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive number (got '${raw}')`);
  }
  return Math.trunc(parsed);
}

/**
 * Note path for an ingested file: an explicit `--path` wins; otherwise the
 * file's basename with a `.md` extension (so the result is searchable — the
 * notes corpus indexes `.md`). e.g. `/tmp/reports/q3.txt` → `q3.md`.
 */
export function resolveIngestNotePath(filePath: string, override?: string): string {
  if (override !== undefined && override.trim().length > 0) return override.trim();
  const base = filePath.split(/[\\/]/u).pop() ?? "note";
  const stem = base.replace(/\.[^.]+$/u, "") || "note";
  return `${stem}.md`;
}

/**
 * Note path for an ingested URL: an explicit `--path` wins; otherwise a `.md`
 * slug from the host + pathname. e.g. `https://www.example.com/blog/post` →
 * `example.com-blog-post.md`.
 */
export function resolveUrlNotePath(rawUrl: string, override?: string): string {
  if (override !== undefined && override.trim().length > 0) return override.trim();
  let locator: string;
  try {
    const url = new URL(rawUrl);
    locator = `${url.hostname.replace(/^www\./u, "")}${url.pathname}`;
  } catch {
    locator = rawUrl;
  }
  const slug = locator
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return `${slug.length > 0 ? slug : "page"}.md`;
}

export function registerNotesCommands(program: Command, io: ProgramIO, helpers: NotesCommandHelpers): void {
  const notes = program.command("notes").description("Personal notes (filesystem-backed)");

  notes
    .command("providers")
    .description("List configured notes backends")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: { readonly json?: boolean }, command) => {
      const result = await helpers.apiRequest(io, command, "/api/notes/providers");
      if (options.json) {
        helpers.writeOutput(io, result);
        return;
      }
      const providers = (result as { providers?: Parameters<typeof formatProvidersList>[1] })?.providers ?? [];
      io.stdout(formatProvidersList("Notes providers", providers));
    });

  notes
    .command("list")
    .description("List notes directory entries (--local skips the API)")
    .option("--subdir <path>", "Subdirectory relative to the notes root")
    .option("--local", "Read directly from the local notes directory instead of the API")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: { readonly subdir?: string } & SharedOptions, command) => {
      const readLocalList = (): Promise<Record<string, unknown>> =>
        callLocalTool("list", options.subdir ? { subdir: options.subdir } : {});
      let payload: Record<string, unknown>;
      if (options.local) {
        payload = await readLocalList();
      } else {
        const path = options.subdir
          ? `/api/notes/list?subdir=${encodeURIComponent(options.subdir)}`
          : "/api/notes/list";
        try {
          payload = (await helpers.apiRequest(io, command, path)) as Record<string, unknown>;
        } catch (cause) {
          if (!isApiUnreachable(cause)) {
            throw cause;
          }
          io.stderr("muse: API not reachable — reading notes from the local directory.\n");
          payload = await readLocalList();
        }
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNotesList(payload as unknown as Parameters<typeof formatNotesList>[0]));
    });

  notes
    .command("read")
    .description("Read a note as UTF-8 (--local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .option("--local", "Read directly from the local notes directory instead of the API")
    .option("--json", "Print the raw API response instead of just the file content")
    .action(async (notePath: string, options: SharedOptions, command) => {
      let payload: Record<string, unknown>;
      if (options.local) {
        payload = await callLocalTool("read", { path: notePath });
      } else {
        const url = `/api/notes/read?path=${encodeURIComponent(notePath)}`;
        payload = (await helpers.apiRequest(io, command, url)) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteRead(payload as unknown as Parameters<typeof formatNoteRead>[0]));
    });

  notes
    .command("search")
    .description("Substring search across .md files (--local skips the API)")
    .argument("<query...>", "Substring to grep for (joined by spaces)")
    .option("--limit <n>", "Max matches (default 20)")
    .option("--local", "Search the local notes directory instead of the API")
    .option("--json", "Print the raw API response instead of grep-style lines")
    .action(async (
      queryParts: readonly string[],
      options: { readonly limit?: string } & SharedOptions,
      command
    ) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        throw new Error("query is required");
      }
      const limit = parseNotesSearchLimit(options.limit);
      let payload: Record<string, unknown>;
      if (options.local) {
        const args: Record<string, unknown> = { query };
        if (limit !== undefined) {
          args.limit = limit;
        }
        payload = await callLocalTool("search", args);
      } else {
        const params = new URLSearchParams({ query });
        if (limit !== undefined) {
          params.set("limit", limit.toString());
        }
        payload = (await helpers.apiRequest(io, command, `/api/notes/search?${params.toString()}`)) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteSearch(payload as unknown as Parameters<typeof formatNoteSearch>[0]));
    });

  notes
    .command("save")
    .description("Write a note (refuses to clobber unless --overwrite; --local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .argument("<content...>", "UTF-8 file contents (joined by spaces)")
    .option("--overwrite", "Replace an existing note in place")
    .option("--local", "Write directly to the local notes directory instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      notePath: string,
      contentParts: readonly string[],
      options: { readonly overwrite?: boolean } & SharedOptions,
      command
    ) => {
      const content = contentParts.join(" ");
      let payload: Record<string, unknown>;
      if (options.local) {
        const args: Record<string, unknown> = { content, path: notePath };
        if (options.overwrite === true) {
          args.overwrite = true;
        }
        payload = await callLocalTool("save", args);
      } else {
        const body: Record<string, unknown> = { content, path: notePath };
        if (options.overwrite === true) {
          body.overwrite = true;
        }
        payload = (await helpers.apiRequest(io, command, "/api/notes/save", body, "POST")) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteSaved(payload as unknown as Parameters<typeof formatNoteSaved>[0]));
    });

  notes
    .command("ingest")
    .description("Ingest a local file OR a web page (--url) into the notes corpus as a searchable .md note")
    .argument("[file]", "Path to a local UTF-8 text file, e.g. './meeting.txt' (omit when using --url)")
    .option("--url <url>", "Ingest a public web page's readable text instead of a local file")
    .option("--path <notePath>", "Note path under the notes root (default: derived from the file/URL as .md)")
    .option("--overwrite", "Replace an existing note in place")
    .option("--local", "Write directly to the local notes directory instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      file: string | undefined,
      options: { readonly url?: string; readonly path?: string; readonly overwrite?: boolean } & SharedOptions,
      command
    ) => {
      const url = options.url?.trim();
      if ((file && url) || (!file && !url)) {
        throw new Error("Provide exactly one source: a <file> argument OR --url <url>");
      }
      let content: string;
      let notePath: string;
      if (url) {
        const result = await fetchReadableUrl(url);
        if (!result.ok) {
          throw new Error(`Could not ingest ${url}: ${result.error}`);
        }
        content = result.title ? `# ${result.title}\n\n${result.text}` : result.text;
        notePath = resolveUrlNotePath(url, options.path);
      } else {
        content = await readFile(file as string, "utf8");
        notePath = resolveIngestNotePath(file as string, options.path);
      }
      let payload: Record<string, unknown>;
      if (options.local) {
        const args: Record<string, unknown> = { content, path: notePath };
        if (options.overwrite === true) args.overwrite = true;
        payload = await callLocalTool("save", args);
      } else {
        const body: Record<string, unknown> = { content, path: notePath };
        if (options.overwrite === true) body.overwrite = true;
        payload = (await helpers.apiRequest(io, command, "/api/notes/save", body, "POST")) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteSaved(payload as unknown as Parameters<typeof formatNoteSaved>[0]));
    });

  notes
    .command("append")
    .description("Tail-append to a note (creates if missing; --local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .argument("<content...>", "UTF-8 text to append (joined by spaces)")
    .option("--local", "Append directly in the local notes directory instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      notePath: string,
      contentParts: readonly string[],
      options: SharedOptions,
      command
    ) => {
      const content = contentParts.join(" ");
      let payload: Record<string, unknown>;
      if (options.local) {
        payload = await callLocalTool("append", { content, path: notePath });
      } else {
        payload = (await helpers.apiRequest(io, command, "/api/notes/append", { content, path: notePath }, "POST")) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteAppended(payload as unknown as Parameters<typeof formatNoteAppended>[0]));
    });

  notes
    .command("delete")
    .description("Delete a note so it stops surfacing in search / knowledge (--local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .option("--local", "Delete directly in the local notes directory instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (notePath: string, options: SharedOptions, command) => {
      let payload: Record<string, unknown>;
      if (options.local) {
        payload = await callLocalTool("delete", { path: notePath });
      } else {
        payload = (await helpers.apiRequest(io, command, `/api/notes?path=${encodeURIComponent(notePath)}`, undefined, "DELETE")) as Record<string, unknown>;
      }
      if (typeof payload.error === "string") {
        io.stderr(`muse notes delete: ${payload.error}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(payload.deleted === true
        ? `Deleted ${String(payload.path ?? notePath)}\n`
        : `No note found at ${String(payload.path ?? notePath)}\n`);
    });
}
