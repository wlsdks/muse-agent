/**
 * `muse notes` command group. Wraps `/api/notes/*` for remote mode
 * and the in-process `createNotesMcpServer` (same engine the API
 * uses) for `--local` mode so the CLI works without an API server.
 *
 * Output: human-readable by default; `--json` opts into the raw
 * envelope for scripting.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";

import { resolveNotesDir, type MuseEnvironment } from "@muse/autoconfigure";
import { createNotesMcpServer, deriveMirrorNoteTitle, fetchReadableUrl } from "@muse/domain-tools";
import { isInteractiveWebEgressAllowed, isLocalOnlyEnabled } from "@muse/model";
import { isRecord } from "@muse/shared";
import { mirrorNoteToApple } from "@muse/macos";
import type { Command } from "commander";

import {
  formatNoteAppended,
  formatNoteRead,
  formatNoteSaved,
  formatNoteSearch,
  formatNotesList,
  formatProvidersList
} from "./human-formatters.js";
import { auditNoteGraph, buildNoteLinkGraph, noteLinkView, planLinkFixes, resolveNoteId, rewriteWikiLinkReferences, type LinkFix } from "./notes-links.js";
import { isApiUnreachable } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";
import { withBestEffort } from "./async-promises.js";

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

function environment(): MuseEnvironment {
  return process.env;
}

type NoteProviderRow = {
  readonly id: string;
  readonly local?: boolean;
  readonly displayName?: string;
  readonly description?: string;
};

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

async function callLocalTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const notesDir = resolveNotesDir(environment());
  const server = createNotesMcpServer({ notesDir });
  const tool = server.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`local notes tool not found: ${name}`);
  }
  const raw = await tool.execute(args as Parameters<typeof tool.execute>[0]);
  const result = toRecord(raw);
  if (result && typeof result.error === "string") {
    throw new Error(result.error);
  }
  return result ?? { result: raw };
}

function parseNotesPayloadRecord(v: unknown): Record<string, unknown> {
  return toRecord(v) ?? {};
}

function parseNotesProviders(raw: unknown): readonly NoteProviderRow[] {
  const payload = parseNotesPayloadRecord(raw);
  const rawProviders = payload.providers;
  if (!Array.isArray(rawProviders)) {
    return [];
  }
  return rawProviders
    .map((entry) => toRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "unknown",
      local: entry.local === true ? true : undefined,
      displayName: typeof entry.displayName === "string" ? entry.displayName : undefined,
      description: typeof entry.description === "string" ? entry.description : undefined
    }))
    .filter((provider) => provider.id.length > 0);
}

function parseNotesListPayload(raw: unknown): {
  readonly dir: string;
  readonly entries: readonly { readonly name: string; readonly isDirectory: boolean; readonly sizeBytes?: number }[];
  readonly truncated?: boolean;
} {
  const payload = parseNotesPayloadRecord(raw);
  const rawEntries = payload.entries;
  const entries = Array.isArray(rawEntries)
    ? rawEntries
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        isDirectory: entry.isDirectory === true,
        sizeBytes: typeof entry.sizeBytes === "number" ? entry.sizeBytes : undefined
      }))
    : [];
  return {
    dir: typeof payload.dir === "string" ? payload.dir : "",
    entries,
    ...(payload.truncated === true ? { truncated: true } : {})
  };
}

function parseNotesReadPayload(raw: unknown): { readonly content: string } {
  const payload = parseNotesPayloadRecord(raw);
  return {
    content: typeof payload.content === "string" ? payload.content : ""
  };
}

function parseNotesSearchPayload(raw: unknown): { readonly matches: readonly { readonly path: string; readonly line: number; readonly snippet: string }[] } {
  const payload = parseNotesPayloadRecord(raw);
  const rawMatches = Array.isArray(payload.matches) ? payload.matches : [];
  return {
    matches: rawMatches
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => ({
        path: typeof entry.path === "string" ? entry.path : "",
        line: typeof entry.line === "number" && Number.isFinite(entry.line) ? entry.line : 0,
        snippet: typeof entry.snippet === "string" ? entry.snippet : ""
      }))
  };
}

function parseNotesSavePayload(raw: unknown): { readonly path: string; readonly sizeBytes?: number; readonly created?: boolean; readonly mirrorNote?: string } {
  const payload = parseNotesPayloadRecord(raw);
  return {
    path: typeof payload.path === "string" ? payload.path : "",
    sizeBytes: typeof payload.sizeBytes === "number" ? payload.sizeBytes : undefined,
    ...(payload.created === true ? { created: true } : {}),
    ...(typeof payload.mirrorNote === "string" ? { mirrorNote: payload.mirrorNote } : {})
  };
}

function parseNotesAppendPayload(raw: unknown): { readonly path: string; readonly sizeBytes?: number } {
  const payload = parseNotesPayloadRecord(raw);
  return {
    path: typeof payload.path === "string" ? payload.path : "",
    sizeBytes: typeof payload.sizeBytes === "number" ? payload.sizeBytes : undefined
  };
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

export interface RenameNoteResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly from?: string;
  readonly to?: string;
  readonly linksRewritten: number;
  readonly notesTouched: number;
  readonly dryRun: boolean;
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
        out.push(full);
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * Rename a note file AND rewrite every `[[wiki-link]]` to it across the corpus,
 * so a rename never silently orphans backlinks (the gap `auditNoteGraph`
 * surfaces with no remedy). The link target is the basename without `.md`
 * (the bare `[[note]]` convention). Refuses a missing source or an existing
 * destination. `--dry-run` counts without writing. Exported + notesDir-injected
 * so the whole flow is testable on a temp corpus.
 */
export async function renameNoteWithLinkRewrite(notesDir: string, fromPath: string, toPath: string, dryRun = false): Promise<RenameNoteResult> {
  const oldAbs = join(notesDir, fromPath);
  const newAbs = join(notesDir, toPath);
  if (!relative(notesDir, oldAbs).length || relative(notesDir, oldAbs).startsWith("..") || relative(notesDir, newAbs).startsWith("..")) {
    return { dryRun, error: "paths must stay inside the notes directory", linksRewritten: 0, notesTouched: 0, ok: false };
  }
  if (!existsSync(oldAbs)) {
    return { dryRun, error: `no note at ${fromPath}`, linksRewritten: 0, notesTouched: 0, ok: false };
  }
  if (existsSync(newAbs)) {
    return { dryRun, error: `${toPath} already exists — refusing to overwrite`, linksRewritten: 0, notesTouched: 0, ok: false };
  }
  const oldTarget = basename(fromPath).replace(/\.md$/iu, "");
  const newTarget = basename(toPath).replace(/\.md$/iu, "");
  let linksRewritten = 0;
  let notesTouched = 0;
  if (oldTarget.toLowerCase() !== newTarget.toLowerCase()) {
    for (const file of await listMarkdownFiles(notesDir)) {
      const body = await readFile(file, "utf8");
      const { body: nextBody, count } = rewriteWikiLinkReferences(body, oldTarget, newTarget);
      if (count > 0) {
        linksRewritten += count;
        notesTouched += 1;
        if (!dryRun) {
          await writeFile(file, nextBody, "utf8");
        }
      }
    }
  }
  if (!dryRun) {
    await mkdir(dirname(newAbs), { recursive: true });
    await rename(oldAbs, newAbs);
  }
  return { dryRun, from: fromPath, linksRewritten, notesTouched, ok: true, to: toPath };
}

export interface FixLinksResult {
  readonly fixes: readonly LinkFix[];
  readonly unresolved: readonly string[];
  readonly linksRewritten: number;
  readonly notesTouched: number;
  readonly dryRun: boolean;
}

/**
 * Repair broken `[[wiki-links]]` across the corpus: build the link graph, find
 * the broken targets (`auditNoteGraph`), snap each to its unique closest note
 * (`planLinkFixes` — ambiguous / no-match left alone), and rewrite them. The
 * complement to `auditNoteGraph`, which only REPORTED broken links. `--dry-run`
 * plans without writing. Exported + notesDir-injected so it's testable on a temp
 * corpus.
 */
export async function fixBrokenLinks(notesDir: string, dryRun = false, maxDistance = 2): Promise<FixLinksResult> {
  const files = await listMarkdownFiles(notesDir);
  const notes = await Promise.all(files.map(async (path) => ({
    body: await readFile(path, "utf8"),
    id: basename(path).replace(/\.md$/iu, ""),
    path
  })));
  const audit = auditNoteGraph(buildNoteLinkGraph(notes.map((n) => ({ body: n.body, id: n.id }))));
  const { fixes, unresolved } = planLinkFixes(audit.brokenLinks.map((b) => b.target), notes.map((n) => n.id), maxDistance);

  let linksRewritten = 0;
  let notesTouched = 0;
  if (fixes.length > 0) {
    for (const note of notes) {
      let body = note.body;
      let changed = 0;
      for (const fix of fixes) {
        const result = rewriteWikiLinkReferences(body, fix.from, fix.to);
        body = result.body;
        changed += result.count;
      }
      if (changed > 0) {
        linksRewritten += changed;
        notesTouched += 1;
        if (!dryRun) {
          await writeFile(note.path, body, "utf8");
        }
      }
    }
  }
  return { dryRun, fixes, linksRewritten, notesTouched, unresolved };
}

/**
 * The note ids that link TO `notePath` via `[[wiki-links]]` — i.e. the backlinks
 * that DELETING the note would leave broken. Builds the link graph over the
 * corpus (same reader as fix-links) and reads the target's backlinks. Computed
 * BEFORE the delete so the target still resolves. notesDir-injected + exported
 * for direct testing. Best-effort: an unreadable corpus yields [].
 */
export async function notesLinkingTo(notesDir: string, notePath: string): Promise<readonly string[]> {
  const files = await listMarkdownFiles(notesDir);
  const notes = await Promise.all(files.map(async (path) => ({
    body: await readFile(path, "utf8"),
    id: basename(path).replace(/\.md$/iu, "")
  })));
  const graph = buildNoteLinkGraph(notes);
  const targetId = resolveNoteId(graph, notePath) ?? basename(notePath).replace(/\.md$/iu, "");
  return noteLinkView(graph, targetId).backlinks;
}

/**
 * Warn that deleting a note leaves its backlinks broken — the delete counterpart
 * of `rename`'s link-preservation. Empty when nothing links to it. Pure.
 */
export function formatBrokenBacklinkWarning(backlinks: readonly string[]): string {
  if (backlinks.length === 0) {
    return "";
  }
  const shown = backlinks.slice(0, 8);
  const more = backlinks.length > shown.length ? ` (+${(backlinks.length - shown.length).toString()} more)` : "";
  return `⚠ ${backlinks.length.toString()} note(s) link to this — their [[wiki-links]] are now broken: ${shown.join(", ")}${more}\n   Repair with \`muse notes fix-links\`.\n`;
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
      const providers = parseNotesProviders(result);
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
          payload = parseNotesPayloadRecord(await helpers.apiRequest(io, command, path));
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
      io.stdout(formatNotesList(parseNotesListPayload(payload)));
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
        payload = parseNotesPayloadRecord(await helpers.apiRequest(io, command, url));
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteRead(parseNotesReadPayload(payload)));
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
        payload = parseNotesPayloadRecord(await helpers.apiRequest(io, command, `/api/notes/search?${params.toString()}`));
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteSearch(parseNotesSearchPayload(payload)));
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
        // Opt-in Apple Notes mirror (MUSE_APPLE_NOTES_MIRROR). Create-only:
        // only a genuine NEW note fires it (never an overwrite-in-place edit).
        // Self-gated + fail-soft — it never blocks or rolls back the local
        // write; a failure surfaces as a `mirrorNote` / stderr warning. The
        // shared `callLocalTool` server is deliberately mirror-free so `ingest`
        // (which reuses `save`) does not over-fire; the mirror is scoped to the
        // deliberate `notes save` create here.
        if (payload.created === true) {
          const mirror = await mirrorNoteToApple({ body: content, title: deriveMirrorNoteTitle(notePath, content) });
          if (mirror.warning) {
            payload = { ...payload, mirrorNote: mirror.warning };
          }
        }
      } else {
        const body: Record<string, unknown> = { content, path: notePath };
        if (options.overwrite === true) {
          body.overwrite = true;
        }
        payload = parseNotesPayloadRecord(await helpers.apiRequest(io, command, "/api/notes/save", body, "POST"));
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      // The API path mirrors server-side and returns `mirrorNote` on a
      // fail-soft miss; surface it (local path set the same field above) so a
      // save isn't silent about a mirror failure.
      if (typeof payload.mirrorNote === "string" && payload.mirrorNote.length > 0) {
        io.stderr(`muse: ${payload.mirrorNote}\n`);
      }
      io.stdout(formatNoteSaved(parseNotesSavePayload(payload)));
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
      if (url && !isInteractiveWebEgressAllowed(process.env)) {
        io.stderr(isLocalOnlyEnabled(process.env)
          ? "muse notes ingest: interactive public-web access is blocked by local-only.\n"
          : "muse notes ingest: interactive public-web access is disabled by MUSE_WEB_EGRESS.\n");
        process.exitCode = 2;
        return;
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
        payload = parseNotesPayloadRecord(await helpers.apiRequest(io, command, "/api/notes/save", body, "POST"));
      }
      // Record external provenance for a URL-ingested note so recall tags its
      // grounding evidence trusted:false (the note-veracity half of GROUNDED≠TRUE —
      // a poisoned web page laundered into a note must not ground as a trusted "your
      // own note"). Fail-soft: a provenance write must never break the ingest.
      if (url) {
        try {
          const { resolveNoteProvenanceFile } = await import("@muse/autoconfigure");
          const { recordIngestedNote } = await import("./note-provenance.js");
          await recordIngestedNote(resolveNoteProvenanceFile(process.env), {
            ingestedAt: new Date().toISOString(),
            path: notePath,
            sourceUrl: url
          });
        } catch { /* provenance is best-effort — never block the ingest */ }
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteSaved(parseNotesSavePayload(payload)));
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
        payload = parseNotesPayloadRecord(await helpers.apiRequest(io, command, "/api/notes/append", { content, path: notePath }, "POST"));
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatNoteAppended(parseNotesAppendPayload(payload)));
    });

  notes
    .command("delete")
    .description("Delete a note so it stops surfacing in search / knowledge (--local skips the API)")
    .argument("<path>", "Note path relative to the notes root")
    .option("--local", "Delete directly in the local notes directory instead of the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (notePath: string, options: SharedOptions, command) => {
      let payload: Record<string, unknown>;
      // For a LOCAL delete, find which notes link to this one BEFORE removing it,
      // so we can warn that their [[wiki-links]] will be left broken (the delete
      // counterpart of `rename`'s link-preservation). Best-effort, never blocks.
      let backlinks: readonly string[] = [];
      if (options.local) {
        backlinks = await withBestEffort(notesLinkingTo(resolveNotesDir(environment()), notePath), []);
        payload = await callLocalTool("delete", { path: notePath });
      } else {
        payload = parseNotesPayloadRecord(await helpers.apiRequest(io, command, `/api/notes?path=${encodeURIComponent(notePath)}`, undefined, "DELETE"));
      }
      if (typeof payload.error === "string") {
        io.stderr(`muse notes delete: ${payload.error}\n`);
        process.exitCode = 1;
        return;
      }
      const broke = payload.deleted === true ? backlinks : [];
      if (options.json) {
        helpers.writeOutput(io, broke.length > 0 ? { ...payload, brokenBacklinks: broke } : payload);
        return;
      }
      io.stdout(payload.deleted === true
        ? `Deleted ${String(payload.path ?? notePath)}\n`
        : `No note found at ${String(payload.path ?? notePath)}\n`);
      const warning = formatBrokenBacklinkWarning(broke);
      if (warning) {
        io.stderr(warning);
      }
    });

  notes
    .command("rename")
    .description("Rename a note AND rewrite every [[wiki-link]] to it across your notes, so links don't break (local)")
    .argument("<from>", "Existing note path relative to the notes root, e.g. 'ideas.md'")
    .argument("<to>", "New note path, e.g. 'concepts.md'")
    .option("--dry-run", "Show how many links would be rewritten without changing anything")
    .option("--json", "Print the raw result")
    .action(async (from: string, to: string, options: { readonly dryRun?: boolean; readonly json?: boolean }) => {
      const notesDir = resolveNotesDir(environment());
      const result = await renameNoteWithLinkRewrite(notesDir, from, to, options.dryRun === true);
      if (options.json) {
        helpers.writeOutput(io, result);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (!result.ok) {
        io.stderr(`muse notes rename: ${result.error ?? "failed"}\n`);
        process.exitCode = 1;
        return;
      }
      const links = result.linksRewritten > 0
        ? `${result.linksRewritten.toString()} link(s) across ${result.notesTouched.toString()} note(s)`
        : "no [[links]] pointed at it";
      io.stdout(result.dryRun
        ? `Would rename ${from} → ${to} (${links === "no [[links]] pointed at it" ? links : `${links} would be rewritten`}).\n`
        : `Renamed ${from} → ${to}${result.linksRewritten > 0 ? `, rewrote ${links}` : ` (${links})`}.\n`);
    });

  notes
    .command("fix-links")
    .description("Repair broken [[wiki-links]] by snapping each to its closest existing note (local)")
    .option("--dry-run", "Show the proposed fixes without changing anything")
    .option("--max-distance <n>", "Max edit distance to treat a typo as the same note (default 2)")
    .option("--json", "Print the raw result")
    .action(async (options: { readonly dryRun?: boolean; readonly maxDistance?: string; readonly json?: boolean }) => {
      const notesDir = resolveNotesDir(environment());
      const maxDistance = options.maxDistance !== undefined && Number.isFinite(Number(options.maxDistance))
        ? Math.max(1, Math.trunc(Number(options.maxDistance)))
        : 2;
      const result = await fixBrokenLinks(notesDir, options.dryRun === true, maxDistance);
      if (options.json) {
        helpers.writeOutput(io, result);
        return;
      }
      if (result.fixes.length === 0 && result.unresolved.length === 0) {
        io.stdout("No broken [[wiki-links]] found.\n");
        return;
      }
      if (result.fixes.length > 0) {
        io.stdout(result.dryRun
          ? `Would fix ${result.linksRewritten.toString()} broken link(s) across ${result.notesTouched.toString()} note(s):\n`
          : `Fixed ${result.linksRewritten.toString()} broken link(s) across ${result.notesTouched.toString()} note(s):\n`);
        for (const fix of result.fixes) {
          io.stdout(`  • [[${fix.from}]] → [[${fix.to}]]\n`);
        }
      }
      if (result.unresolved.length > 0) {
        io.stdout(`${result.unresolved.length.toString()} link(s) left unresolved (no unique close match): ${result.unresolved.map((u) => `[[${u}]]`).join(", ")}\n`);
      }
    });
}
