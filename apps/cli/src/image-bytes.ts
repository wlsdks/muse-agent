/**
 * Magic-byte image sniffing — the single source of truth for "are these
 * bytes actually an image, and which kind?". Content-trust, not
 * extension-trust: a file named `note.png` whose bytes are plain text (or
 * a renamed PDF) must NOT pass as an image. Shared by `muse show` (don't
 * render a non-image) and the `muse ask --image` attachment gate (don't
 * ship non-image bytes to the vision model with a fabricated mimeType).
 */

/** True iff `buffer` begins with a recognised image magic-byte signature
 *  (PNG / JPEG / GIF / WebP / HEIC-AVIF / BMP). */
export function looksLikeImage(buffer: Buffer): boolean {
  return sniffImageMime(buffer) !== null;
}

/** The image MIME type implied by `buffer`'s magic bytes, or `null` when
 *  the bytes are not a recognised image. */
export function sniffImageMime(buffer: Buffer): string | null {
  const startsWith = (...bytes: number[]): boolean =>
    buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png"; // PNG
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg"; // JPEG
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif"; // GIF8
  if (startsWith(0x42, 0x4d)) return "image/bmp"; // BMP
  // WebP: "RIFF" .... "WEBP"
  if (buffer.length >= 12 && startsWith(0x52, 0x49, 0x46, 0x46)
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return "image/webp";
  }
  // ISO-BMFF (HEIC / AVIF): bytes 4-7 are 'ftyp'.
  if (buffer.length >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return "image/heic";
  }
  return null;
}
