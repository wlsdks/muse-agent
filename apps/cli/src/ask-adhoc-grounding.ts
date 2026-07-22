import { errorMessage } from "@muse/shared";
/**
 * Ad-hoc grounding for `muse ask`, lifted out of the commands-ask god-file:
 * ground THIS answer on a specific --file (or folder), a public --url, or the
 * --clipboard WITHOUT ingesting any of it into the notes corpus. Each source is
 * read-only and reuses the NOTES citation class (cited `[from <path>]` /
 * `[from <host>]` / `[from clipboard]`) under the same code gate, so an off-topic
 * question still honestly refuses. Pushes the selected passages into the shared
 * `scored` array (mutated in place), records the "open to verify" target for a
 * --url / --clipboard source, and returns the possibly-cleared `notesUnavailable`
 * flag (ad-hoc note-class grounding means notes are no longer "unavailable").
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { chunkText, lexicalOverlap, lexicalTokens } from "@muse/agent-core";
import { fetchReadableUrl } from "@muse/domain-tools";
import { isInteractiveWebEgressAllowed, isLocalOnlyEnabled } from "@muse/model";
import { looksLikeBinaryContent, selectFilePassages, urlGroundingSource, type ScoredChunk } from "@muse/recall";

import { readClipboardText } from "./clipboard-reader.js";
import { docxToText, emlToText, extractDirectoryDocuments, formatDirectoryCapNotice, formatUrlTruncationNotice, htmlToText, isDocxDocument, isEmlDocument, isHtmlDocument, isPdfDocument, isPptxDocument, parsePdfBuffer, pptxToText } from "./document-reader.js";

export async function applyAdHocGrounding(params: {
  readonly options: {
    readonly file?: string;
    readonly url?: string;
    readonly clipboard?: boolean;
    readonly json?: boolean;
  };
  readonly query: string;
  readonly scored: ScoredChunk[];
  readonly notesUnavailable: boolean;
  readonly adHocVerifyTargets: Map<string, string | null>;
  readonly onStderr: (text: string) => void;
}): Promise<{ notesUnavailable: boolean }> {
  const { options, query, scored, adHocVerifyTargets, onStderr } = params;
  let notesUnavailable = params.notesUnavailable;

  // --file: ad-hoc grounding on an explicitly-named file (read-only, NOT
  // ingested into the corpus). Reuses the NOTES citation class — the file's
  // passages are injected as note-class context cited `[from <path>]` under
  // the same code gate (the cite token + allowedNotes normalise the path
  // identically, so it survives the gate). Lexically ranks the file's
  // passages against the question and injects the strongest up to a budget,
  // so a large file doesn't blow the small model's context; an off-topic
  // question sees real content that lacks the answer ⇒ honest refusal.
  if (options.file && options.file.trim().length > 0) {
    const fileLabel = options.file.trim();
    const fileIsDirectory = (() => {
      try {
        return statSync(fileLabel).isDirectory();
      } catch {
        return false;
      }
    })();
    if (fileIsDirectory) {
      // --file <dir>: ground on the FOLDER's documents without ingesting them.
      // Each supported doc (.txt/.md/.pdf/.log/.csv) is extracted, its passages
      // ranked by query overlap across all files, and the strongest kept within
      // a budget — cited per-file `[from <name>]`. An off-topic question finds no
      // overlapping passage ⇒ honest refusal (never a general-knowledge guess).
      try {
        const { documents: docs, totalFound, cap } = await extractDirectoryDocuments(fileLabel);
        if (docs.length === 0) {
          onStderr(`muse: --file ${fileLabel} — no readable text/PDF documents found in that folder (text / markdown / .org / .rst / PDF / .csv / .html / .eml).\n`);
        } else {
          // Honest about a truncated big folder — never silently ground on a subset.
          const capNotice = formatDirectoryCapNotice(fileLabel, totalFound, cap);
          if (capNotice) {
            onStderr(capNotice);
          }
          const queryTokens = lexicalTokens(query);
          const pool = docs
            .flatMap((doc) => chunkText(doc.text, 1200).map((text) => ({ file: doc.path, overlap: lexicalOverlap(queryTokens, text), text })))
            .filter((passage) => passage.overlap > 0)
            .sort((a, b) => b.overlap - a.overlap);
          let budget = 6000;
          let pickedCount = 0;
          for (const passage of pool) {
            if (budget <= 0) break;
            scored.push({ chunk: { chunkIndex: pickedCount, embedding: [], file: passage.file, text: passage.text }, file: passage.file, score: 1 });
            budget -= passage.text.length;
            pickedCount += 1;
          }
          if (pickedCount > 0) {
            notesUnavailable = false;
          }
        }
      } catch (cause) {
        onStderr(`muse: could not read --file ${fileLabel} (${errorMessage(cause)})\n`);
      }
    } else {
    try {
      const bytes = await readFile(fileLabel);
      let fileText: string | undefined;
      if (isPdfDocument(fileLabel, bytes)) {
        // A real PDF: extract its TEXT via pdf-parse (the same reader `muse
        // read` uses) and ground on that — so a user can ask about a PDF
        // directly. A scanned/empty PDF yields no text ⇒ honest refusal.
        try {
          const extracted = (await parsePdfBuffer(bytes)).text;
          if (extracted.trim().length > 0) {
            fileText = extracted;
          } else {
            onStderr(`muse: --file ${fileLabel} is a PDF with no extractable text (it may be scanned images) — I can't ground on it.\n`);
          }
        } catch (pdfErr) {
          onStderr(`muse: --file ${fileLabel} could not be read as a PDF (${errorMessage(pdfErr)}) — I won't ground on it.\n`);
        }
      } else if (isEmlDocument(fileLabel)) {
        // A saved email — extract the decoded subject/sender + readable body
        // (reusing the mbox MIME parser) so it grounds as the message, not raw
        // RFC822 headers and quoted-printable/base64 noise. Before the binary
        // check: an .eml's text headers never trip it, and a base64 part inside
        // is exactly what the parser decodes.
        fileText = emlToText(bytes.toString("utf8"));
      } else if (isDocxDocument(fileLabel)) {
        // A Word .docx is a ZIP of XML, so it trips the binary check below —
        // extract its body text BEFORE that refusal (the same way .eml is).
        try {
          fileText = docxToText(bytes, fileLabel);
        } catch (docxErr) {
          onStderr(`muse: --file ${fileLabel} could not be read as a .docx (${errorMessage(docxErr)}) — I won't ground on it.\n`);
        }
      } else if (isPptxDocument(fileLabel)) {
        // A PowerPoint .pptx is likewise a ZIP of XML — extract its slide text
        // BEFORE the binary refusal below.
        try {
          fileText = pptxToText(bytes, fileLabel);
        } catch (pptxErr) {
          onStderr(`muse: --file ${fileLabel} could not be read as a .pptx (${errorMessage(pptxErr)}) — I won't ground on it.\n`);
        }
      } else if (looksLikeBinaryContent(bytes)) {
        // A non-PDF binary (image, archive, office doc): refuse — feeding
        // garbled UTF-8 to the model makes it hallucinate content and cite
        // it to the file. Tell the user how to make it groundable instead.
        onStderr(
          `muse: --file ${fileLabel} looks like a binary file (image, office doc, …), not text — ` +
          `I won't ground on it, because reading it as text would feed garbled bytes that I might ` +
          `answer from incorrectly. Export it to .txt/.md and pass that.\n`
        );
      } else if (isHtmlDocument(fileLabel)) {
        // Extract the readable text from HTML — grounding on raw markup feeds
        // <script>/<style> noise and leaves entities undecoded (a mangled
        // "jane&#64;globex.com" instead of "jane@globex.com").
        fileText = htmlToText(bytes.toString("utf8"));
      } else {
        fileText = bytes.toString("utf8");
      }
      if (fileText !== undefined) {
        const picked = selectFilePassages(fileText, query);
        for (const passage of picked) {
          scored.push({ chunk: { chunkIndex: passage.chunkIndex, embedding: [], file: fileLabel, text: passage.text }, file: fileLabel, score: 1 });
        }
        if (picked.length > 0) {
          notesUnavailable = false; // we DO have note-class grounding now
        }
      }
    } catch (cause) {
      onStderr(`muse: could not read --file ${fileLabel} (${errorMessage(cause)})\n`);
    }
    }
  }

  // --url: ad-hoc grounding on a public web page WITHOUT ingesting it (the web
  // counterpart of --file). fetchReadableUrl is SSRF-guarded (public hosts
  // only, re-checked after redirects) and extracts the readable text; we ground
  // on it cited `[from <host>]`. An off-topic question finds no overlap ⇒ honest
  // refusal; a fetch failure is reported, never silently grounded-on-nothing.
  if (options.url && options.url.trim().length > 0) {
    const urlLabel = options.url.trim();
    if (!isInteractiveWebEgressAllowed(process.env)) {
      onStderr(isLocalOnlyEnabled(process.env)
        ? "muse: interactive public-web access is blocked by local-only.\n"
        : "muse: interactive public-web access is disabled by MUSE_WEB_EGRESS.\n");
    } else {
      if (!options.json) {
        onStderr(`🌐 fetching ${urlLabel}…\n`);
      }
      try {
        const fetched = await fetchReadableUrl(urlLabel, {
        maxChars: 60_000,
        // Read an online PDF (a policy doc / paper / manual linked on the web)
        // via the same pdf-parse path `--file <pdf>` uses, instead of refusing it.
        pdfExtractor: async (bytes) => (await parsePdfBuffer(Buffer.from(bytes))).text
      });
        if (!fetched.ok) {
          onStderr(`muse: could not fetch --url ${urlLabel} (${fetched.error}) — I won't ground on it.\n`);
        } else if (fetched.text.trim().length > 0) {
          const source = urlGroundingSource(fetched.finalUrl);
          adHocVerifyTargets.set(source, fetched.finalUrl);
        // Honest about a truncated long page — never silently ground on a prefix.
          if (fetched.truncated) {
            onStderr(formatUrlTruncationNotice(source, 60_000));
          }
          const picked = selectFilePassages(fetched.text, query);
          for (const passage of picked) {
            scored.push({ chunk: { chunkIndex: passage.chunkIndex, embedding: [], file: source, text: passage.text }, file: source, score: 1 });
          }
          if (picked.length > 0) {
            notesUnavailable = false;
          }
        } else {
          onStderr(`muse: --url ${urlLabel} returned no readable text — I can't ground on it.\n`);
        }
      } catch (cause) {
        onStderr(`muse: could not fetch --url ${urlLabel} (${errorMessage(cause)})\n`);
      }
    }
  }

  // --clipboard: ad-hoc grounding on whatever the user just copied — the
  // ephemeral sibling of --file/--url. Read-only and local (shells out to
  // pbpaste / xclip / Get-Clipboard). Grounds on it cited `[from clipboard]`;
  // an empty clipboard or a read failure is reported, never grounded-on-nothing.
  if (options.clipboard) {
    if (!options.json) {
      onStderr("📋 reading your clipboard…\n");
    }
    try {
      const clipText = await readClipboardText();
      if (clipText.trim().length > 0) {
        adHocVerifyTargets.set("clipboard", null);
        const picked = selectFilePassages(clipText, query);
        for (const passage of picked) {
          scored.push({ chunk: { chunkIndex: passage.chunkIndex, embedding: [], file: "clipboard", text: passage.text }, file: "clipboard", score: 1 });
        }
        if (picked.length > 0) {
          notesUnavailable = false;
        }
      } else {
        onStderr("muse: your clipboard is empty — I can't ground on it.\n");
      }
    } catch (cause) {
      onStderr(`muse: could not read the clipboard (${errorMessage(cause)}) — I won't ground on it.\n`);
    }
  }

  return { notesUnavailable };
}
