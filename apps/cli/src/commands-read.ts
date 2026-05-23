/**
 * `muse read <pdf>` — local document understanding via pdf-parse.
 *
 * Goal 088 — Muse can ingest a PDF in one of two shapes:
 *   - default        : print extracted text to stdout
 *   - `--ask "..."`  : prepend the extracted text to a system
 *                      prompt and stream a reply via the
 *                      configured model provider
 *
 * Pure-local — `pdf-parse` is MIT, ~40KB, pure JS. No native
 * deps, no cloud roundtrip beyond whatever model the user
 * already configured.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { createMuseRuntimeAssembly, resolveNotesDir } from "@muse/autoconfigure";
import { LocalDirNotesProvider } from "@muse/mcp";
import { redactSecretsInText } from "@muse/shared";
import type { Command } from "commander";

import { consumeAskStream, type AskStreamEvent } from "./commands-ask.js";
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

interface PdfParsed {
  readonly text: string;
  readonly pageCount: number;
}

/**
 * Goal 088 — pdf-parse v2 exposes a `PDFParse` class. Build,
 * extract text, normalise to a tiny `{ text, pageCount }` subset
 * the CLI cares about. Exported only for testing.
 */
export async function parsePdfBuffer(buffer: Buffer): Promise<PdfParsed> {
  const mod = await import("pdf-parse") as unknown as {
    PDFParse: new (opts: { data: Buffer }) => {
      getText(): Promise<{ text?: string; total?: number; pages?: unknown[] }>;
    };
  };
  const parser = new mod.PDFParse({ data: buffer });
  const result = await parser.getText();
  const pageCount = typeof result.total === "number"
    ? result.total
    : Array.isArray(result.pages) ? result.pages.length : 0;
  return { text: result.text ?? "", pageCount };
}

/** A file is treated as PDF by its `.pdf` extension OR a `%PDF-` magic header. */
export function isPdfDocument(filePath: string, buffer: Buffer): boolean {
  return filePath.toLowerCase().endsWith(".pdf") || buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** A NUL byte in the first 8KB marks a binary file (jpg/png/zip/…) — not readable text. */
export function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Extract text from a local document: a PDF via pdf-parse, otherwise a
 * UTF-8 text file (`.txt` / `.md` / `.log` / `.csv` / transcript — one
 * "page"). Throws on a binary non-PDF so `muse read photo.jpg` reports
 * clearly instead of dumping garbage. Exported for testing.
 */
export async function extractDocumentText(filePath: string, buffer: Buffer): Promise<PdfParsed> {
  if (isPdfDocument(filePath, buffer)) {
    return parsePdfBuffer(buffer);
  }
  if (isLikelyBinary(buffer)) {
    throw new Error(`'${basename(filePath)}' looks binary — muse read handles PDFs and text files (.txt/.md/.log/.csv).`);
  }
  return { pageCount: 1, text: buffer.toString("utf8") };
}

/**
 * Goal 088 — system prompt the `--ask` path uses. Pure so a test
 * can assert it stays grounded ("answer FROM the document, say
 * so if it's not in there").
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
    .description("Read a local PDF or text file (.txt/.md/.log/.csv); optionally answer a question grounded in its text")
    .argument("<path>", "Path to a .pdf or text file")
    .option("--ask <question>", "Stream an LLM answer grounded in the PDF text")
    .option("--model <id>", "Model override for --ask (defaults to MUSE_MODEL)")
    .option("--json", "Emit a structured payload instead of plain text")
    .option("--save-to-notes <id>", "Save the extracted text as a note (relative to MUSE_NOTES_DIR) so knowledge_search can find it")
    .action(async (filePath: string, options: ReadOptions) => {
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
          try {
            await saveDocumentToNotes(notesDir, options.saveToNotes.trim(), filePath, text, parsed.pageCount);
            io.stderr(`(saved ${parsed.pageCount.toString()}-page document to ${options.saveToNotes.trim()} in ${notesDir} — now searchable via knowledge_search)\n`);
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
