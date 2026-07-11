/**
 * `muse ask` input composition, lifted out of the commands-ask god-file:
 * args + piped stdin → the question text (per the same idiom as `muse chat`),
 * plus any `--image` / `--auto-image` attachments the model should SEE.
 *
 * The piped-stdin read has a first-byte timeout baked into `readPipedStdin`
 * (ce9f7897) so a headless caller with a non-EOF stdin doesn't hang forever —
 * moved here unmodified.
 */

import { readPipedStdin } from "./chat-repl.js";
import { collectAutoImageAttachments, loadImageAttachment } from "./ask-image-attachments.js";
import type { AskOptions } from "./ask-command-options.js";
import type { ProgramIO } from "./program.js";

export interface AskImageAttachment {
  readonly mimeType: string;
  readonly dataBase64: string;
}

export type AskInputResult =
  | { readonly ok: true; readonly query: string; readonly imageAttachments: readonly AskImageAttachment[] }
  | { readonly ok: false };

/**
 * Composition follows the same idiom as `muse chat`:
 *   args + stdin → instruction first, content after
 *   args only     → use args
 *   stdin only    → treat stdin as the question
 *   neither       → usage error
 * Lets `cat doc.md | muse ask "summarize this"` work, plus
 * `echo "question?" | muse ask` for headless pipelines.
 *
 * On a usage error or a failed `--image` load, writes the message to
 * `io.stderr` and returns `{ ok: false }` — the caller sets
 * `process.exitCode` and returns early.
 */
export async function composeAskInput(
  queryParts: readonly string[],
  options: Pick<AskOptions, "image" | "autoImage">,
  io: Pick<ProgramIO, "stderr" | "readPipedStdin">
): Promise<AskInputResult> {
  const argQuery = queryParts.join(" ").trim();
  const piped = await (io.readPipedStdin ?? readPipedStdin)();

  let query: string;
  if (argQuery.length > 0 && piped.length > 0) {
    query = `${argQuery}\n\n${piped}`;
  } else if (argQuery.length > 0) {
    query = argQuery;
  } else if (piped.length > 0) {
    query = piped;
  } else if (options.image) {
    query = "Describe this image.";
  } else {
    io.stderr("usage: muse ask <query>   |   cat content | muse ask [optional-instruction]\n");
    return { ok: false };
  }

  // Multimodal: load a local image so the model can SEE it (the runtime
  // carries `attachments` through to the Ollama adapter → gemma4 vision).
  let imageAttachments: readonly AskImageAttachment[] = [];
  if (options.image) {
    const loaded = await loadImageAttachment(options.image);
    if (!loaded.ok) {
      io.stderr(`${loaded.error}\n`);
      return { ok: false };
    }
    imageAttachments = [loaded.attachment];
  }

  // --auto-image: attach image paths mentioned in the message itself, so a
  // user can drop a path inline without --image. Gated (path-safe + existing
  // + valid image bytes); a path that fails any check is silently skipped so
  // auto-detection never errors the ask. Augments any explicit --image.
  if (options.autoImage) {
    const auto = await collectAutoImageAttachments(query);
    if (auto.length > 0) {
      imageAttachments = [...imageAttachments, ...auto];
    }
  }

  return { ok: true, query, imageAttachments };
}
