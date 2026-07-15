import { errorMessage } from "@muse/shared";
/**
 * `muse ask --image` / `--auto-image` attachment loading, lifted out of the
 * commands-ask god-file. Resolves a local image path to an inline base64
 * attachment the runtime carries to the Ollama adapter's per-message `images`
 * (gemma4 vision): extension → MIME, byte-sniff to reject a mislabelled/corrupt
 * file, and (for --auto-image) a path-safety gate so credential/key material in a
 * query is never silently attached.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { resolveImageAttachmentCandidates } from "@muse/domain-tools";
import { isSensitivePath } from "@muse/fs";

import { loadAutoImageAttachments } from "./auto-image.js";
import { sniffImageMime } from "./image-bytes.js";

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

type LoadedImage =
  | { readonly ok: true; readonly attachment: { readonly mimeType: string; readonly dataBase64: string } }
  | { readonly ok: false; readonly error: string };

/** Load a local image file as an inline base64 attachment for `muse ask --image`
 *  (and `muse chat --image`). The runtime carries it to the Ollama adapter's
 *  per-message `images` (gemma4 vision). */
export async function loadImageAttachment(filePath: string): Promise<LoadedImage> {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  const mimeType = IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) {
    return { error: `muse ask --image: unsupported image type '${ext || filePath}' (use PNG/JPEG/GIF/WebP/HEIC/BMP)`, ok: false };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (cause) {
    return { error: `muse ask --image: could not read ${filePath}: ${errorMessage(cause)}`, ok: false };
  }
  if (bytes.length === 0) {
    return { error: `muse ask --image: ${filePath} is empty (0 bytes)`, ok: false };
  }
  const sniffedMime = sniffImageMime(bytes);
  if (sniffedMime === null) {
    return { error: `muse ask --image: ${filePath} does not contain image data (bytes aren't PNG/JPEG/GIF/WebP/HEIC/BMP) — the extension may be wrong or the file corrupt`, ok: false };
  }
  return { attachment: { dataBase64: bytes.toString("base64"), mimeType: sniffedMime }, ok: true };
}

/** `--auto-image` composition: image paths found in `query` that are path-safe
 *  (not credential/key material), exist, and load as valid image bytes. The
 *  real-deps wiring of {@link loadAutoImageAttachments}; exported for direct
 *  coverage so the gate+load chain is tested without the full ask command. */
export function collectAutoImageAttachments(query: string): Promise<readonly { readonly mimeType: string; readonly dataBase64: string }[]> {
  return loadAutoImageAttachments(query, {
    resolve: (text) => resolveImageAttachmentCandidates(text, { isPathSafe: (p) => !isSensitivePath(p), fileExists: existsSync }),
    loadImage: loadImageAttachment
  });
}

