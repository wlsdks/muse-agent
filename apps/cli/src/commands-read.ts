/**
 * `muse read <pdf>` — local document understanding via pdf-parse.
 *
 * Muse can ingest a PDF in one of two shapes:
 *   - default        : print extracted text to stdout
 *   - `--ask "..."`  : prepend the extracted text to a system
 *                      prompt and stream a reply via the
 *                      configured model provider
 *
 * Pure-local — `pdf-parse` is MIT, ~40KB, pure JS. No native
 * deps, no cloud roundtrip beyond whatever model the user
 * already configured.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, sep } from "node:path";

import { createMuseRuntimeAssembly, resolveNotesDir } from "@muse/autoconfigure";
import { LocalDirNotesProvider } from "@muse/domain-tools";
import { redactSecretsInText } from "@muse/shared";
import type { Command } from "commander";

import { consumeAskStream, type AskStreamEvent } from "./commands-ask.js";
import { extractDocumentText, walkDocuments, type PdfParsed } from "./document-reader.js";
import type { ProgramIO } from "./program.js";
import { withSigintAbort } from "./sigint-abort.js";

interface ReadOptions {
  readonly ask?: string;
  readonly model?: string;
  readonly json?: boolean;
  readonly saveToNotes?: string;
}

/**
 * Markdown note body for an ingested document — the extracted text
 * (secret-scrubbed, since a note is long-lived and may sync to a
 * third-party store) under a source header. Saving this makes the
 * document searchable via `knowledge_search` (which spans notes).
 */
export function buildDocumentNoteBody(sourcePath: string, text: string, pageCount: number): { title: string; body: string } {
  const title = `Document — ${basename(sourcePath)}`;
  const body = [
    `# ${title}`,
    "",
    `Source: ${sourcePath} (${pageCount.toString()} page${pageCount === 1 ? "" : "s"})`,
    "",
    redactSecretsInText(text),
    ""
  ].join("\n");
  return { body, title };
}

/**
 * The notes-index walker only indexes `.md/.markdown/.txt/.pdf`, so a note
 * saved under a bare extensionless id (e.g. `--save-to-notes garage`) is
 * written verbatim as `garage` and NEVER picked up by `muse ask` — the
 * "now searchable" claim would be false. Append `.md` unless the id already
 * carries an indexable text extension.
 */
export function ensureNoteMarkdownExtension(id: string): string {
  return /\.(md|markdown|txt)$/iu.test(id) ? id : `${id}.md`;
}

/** Persist an ingested document's text as a markdown note (overwrite by id). */
export async function saveDocumentToNotes(
  notesDir: string,
  noteId: string,
  sourcePath: string,
  text: string,
  pageCount: number
): Promise<void> {
  const { title, body } = buildDocumentNoteBody(sourcePath, text, pageCount);
  const provider = new LocalDirNotesProvider({ notesDir });
  await provider.save({ body, id: noteId, overwrite: true, title: title.slice(0, 120) });
}

// Document text extraction lives in the leaf `document-reader` module so both
// `muse read` and `muse ask --file` can use it without an import cycle. Re-export
// the surface so existing importers of these from `commands-read` keep working.
export { isLikelyBinary, isPdfDocument, parsePdfBuffer } from "./document-reader.js";
export { extractDocumentText };

/** Derive a sandbox-safe note id from a file's path relative to the scanned dir. */
export function noteIdForDocument(dir: string, filePath: string, prefix: string): string {
  const rel = relative(dir, filePath).split(sep).join("/");
  const noExt = rel.slice(0, rel.length - extname(rel).length) || rel;
  const cleanPrefix = prefix.replace(/^\/+|\/+$/gu, "");
  return cleanPrefix.length > 0 ? `${cleanPrefix}/${noExt}` : noExt;
}

export interface DirIngestSummary {
  readonly ingested: number;
  readonly skipped: number;
  readonly total: number;
}

/**
 * Bulk-ingest every supported document under `dir` into the notes corpus
 * (one note per file, id derived from its relative path under `prefix`),
 * so a beachhead user gets a whole folder of real files searchable in ONE
 * command. Per-file progress + partial-failure tolerance (a corrupt /
 * binary / empty file is SKIPPED with a `✗` line, never aborts the run),
 * mirroring the reindex ingest contract. Reuses `extractDocumentText` +
 * `saveDocumentToNotes`, so the production read/save path runs unchanged.
 */
export async function ingestDirectoryToNotes(
  dir: string,
  notesDir: string,
  prefix: string,
  onProgress?: (line: string) => void
): Promise<DirIngestSummary> {
  const files = await walkDocuments(dir);
  let ingested = 0, skipped = 0;
  for (const file of files) {
    let text: string;
    let pageCount: number;
    try {
      const parsed = await extractDocumentText(file, await readFile(file));
      text = (parsed.text ?? "").trim();
      pageCount = parsed.pageCount;
    } catch (cause) {
      skipped += 1;
      onProgress?.(`✗ ${file} (could not read — skipped: ${cause instanceof Error ? cause.message : String(cause)})`);
      continue;
    }
    if (text.length === 0) {
      skipped += 1;
      onProgress?.(`✗ ${file} (no text extracted — skipped)`);
      continue;
    }
    // Save with an indexable extension so the notes-index walker (which
    // only indexes .md/.markdown/.txt/.pdf) actually picks the ingested
    // note up — a bare extensionless id is written verbatim and would
    // never be searchable via `muse ask`.
    const id = ensureNoteMarkdownExtension(noteIdForDocument(dir, file, prefix));
    try {
      await saveDocumentToNotes(notesDir, id, file, text, pageCount);
      ingested += 1;
      onProgress?.(`+ ${file} → ${id}`);
    } catch (cause) {
      skipped += 1;
      onProgress?.(`✗ ${file} (save failed — skipped: ${cause instanceof Error ? cause.message : String(cause)})`);
    }
  }
  return { ingested, skipped, total: files.length };
}

/**
 * System prompt the `--ask` path uses. Pure so a test can assert
 * it stays grounded ("answer FROM the document, say so if it's not
 * in there").
 */
export function buildReadAskSystemPrompt(documentText: string): string {
  return [
    "You are Muse, the user's JARVIS-style assistant. You have been handed a document.",
    "Answer the user's question USING ONLY the document content below. If the answer is not in the document, say so directly — do not invent.",
    "Cite quoted phrases inline in single quotes. Keep replies under 4 sentences unless the question explicitly needs more.",
    "",
    "=== DOCUMENT START ===",
    documentText,
    "=== DOCUMENT END ==="
  ].join("\n");
}

export function registerReadCommand(program: Command, io: ProgramIO): void {
  program
    .command("read")
    .description("Read a local PDF or text file (.txt/.md/.log/.csv); optionally answer a question grounded in its text. Point at a DIRECTORY with --save-to-notes to bulk-ingest a whole folder of documents into your corpus.")
    .argument("<path>", "Path to a .pdf or text file, OR a directory (with --save-to-notes) to bulk-ingest")
    .option("--ask <question>", "Stream an LLM answer grounded in the PDF text")
    .option("--model <id>", "Model override for --ask (defaults to MUSE_MODEL)")
    .option("--json", "Emit a structured payload instead of plain text")
    .option("--save-to-notes <id>", "Save the extracted text as a note (relative to MUSE_NOTES_DIR) so knowledge_search can find it. With a DIRECTORY path, this is the folder PREFIX under which every ingested doc is saved (e.g. 'downloads').")
    .action(async (filePath: string, options: ReadOptions) => {
      // Directory path + --save-to-notes → bulk-ingest the whole folder into
      // the corpus (one command for a beachhead user's pile of real docs).
      let isDir = false;
      try {
        isDir = (await stat(filePath)).isDirectory();
      } catch { /* fall through to the single-file reader, which reports the error */ }
      if (isDir) {
        const prefix = options.saveToNotes?.trim() ?? "";
        if (!options.saveToNotes || prefix.length === 0) {
          io.stderr("muse read <dir>: bulk folder ingest needs --save-to-notes <prefix> (e.g. --save-to-notes downloads)\n");
          process.exitCode = 1;
          return;
        }
        const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
        io.stdout(`muse read — ingesting documents from ${filePath} into ${notesDir} (prefix '${prefix}')\n`);
        const summary = await ingestDirectoryToNotes(filePath, notesDir, prefix, (line) => io.stderr(`  ${line}\n`));
        io.stdout(`(ingested ${summary.ingested.toString()} document(s), skipped ${summary.skipped.toString()} of ${summary.total.toString()} — now searchable via \`muse ask\`)\n`);
        if (summary.ingested === 0) {
          process.exitCode = 1;
        }
        return;
      }

      let buffer: Buffer;
      try {
        buffer = await readFile(filePath);
      } catch (cause) {
        io.stderr(`muse read: could not read ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      let parsed: PdfParsed;
      try {
        parsed = await extractDocumentText(filePath, buffer);
      } catch (cause) {
        io.stderr(`muse read: could not read document: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const text = (parsed.text ?? "").trim();

      if (options.saveToNotes && options.saveToNotes.trim().length > 0) {
        if (text.length === 0) {
          io.stderr("muse read: no text extracted — nothing to save to notes.\n");
        } else {
          const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
          const saveId = ensureNoteMarkdownExtension(options.saveToNotes.trim());
          try {
            await saveDocumentToNotes(notesDir, saveId, filePath, text, parsed.pageCount);
            io.stderr(`(saved ${parsed.pageCount.toString()}-page document to ${saveId} in ${notesDir} — now searchable via \`muse ask\` and knowledge_search)\n`);
          } catch (cause) {
            io.stderr(`(failed to save document to notes: ${cause instanceof Error ? cause.message : String(cause)})\n`);
            process.exitCode = 1;
          }
        }
      }

      if (!options.ask) {
        if (options.json) {
          io.stdout(`${JSON.stringify({ text, pageCount: parsed.pageCount }, null, 2)}\n`);
          return;
        }
        io.stdout(text.length > 0 ? `${text}\n` : "(no text extracted from PDF)\n");
        return;
      }

      // --ask path: stream through the configured model provider.
      const assembly = createMuseRuntimeAssembly();
      const model = options.model ?? assembly.defaultModel;
      if (!assembly.modelProvider || !model) {
        io.stderr("muse read --ask: requires a configured model (set MUSE_MODEL or pass --model)\n");
        process.exitCode = 2;
        return;
      }
      const systemPrompt = buildReadAskSystemPrompt(text);
      let answer = "";
      let streamError: string | undefined;
      await withSigintAbort(async (signal) => {
        const res = await consumeAskStream(
          assembly.modelProvider!.stream({
            messages: [
              { content: systemPrompt, role: "system" },
              { content: options.ask!, role: "user" }
            ],
            model
          }) as AsyncIterable<AskStreamEvent>,
          (text) => { if (!options.json) io.stdout(text); },
          () => signal.aborted
        );
        answer = res.answer;
        streamError = res.error;
      }, { onSigint: () => { if (!options.json) io.stderr("\n(Ctrl-C — aborting…)\n"); } });
      if (streamError !== undefined) {
        io.stderr(`\n(error: ${streamError})\n`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        io.stdout(`${JSON.stringify({ model, ask: options.ask, answer, pageCount: parsed.pageCount }, null, 2)}\n`);
      } else {
        io.stdout("\n");
      }
    });
}
