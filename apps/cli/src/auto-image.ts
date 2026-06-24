/**
 * MED-12 (orchestration) — turn the image references in a user's message
 * into loaded attachments for `muse ask --auto-image`. Composes the gated
 * candidate resolver (path-safe + existing local image paths) with the
 * image loader, dropping any candidate that fails to load (a referenced
 * path that isn't a valid image is silently skipped — auto-detection must
 * never error the whole ask). Both the resolver and loader are INJECTED so
 * this is unit-tested without the filesystem; the `--auto-image` flag wiring
 * (which supplies the real path-safety gate + loader) is the attended step.
 */

export interface AutoImageAttachment {
  readonly mimeType: string;
  readonly dataBase64: string;
}

export interface AutoImageDeps {
  /** Path-safe + existing local image paths from the text (wire resolveImageAttachmentCandidates). */
  readonly resolve: (text: string) => readonly string[];
  /** Load + validate one path as an image (wire loadImageAttachment). */
  readonly loadImage: (path: string) => Promise<{ ok: true; attachment: AutoImageAttachment } | { ok: false; error: string }>;
}

export async function loadAutoImageAttachments(text: string, deps: AutoImageDeps): Promise<readonly AutoImageAttachment[]> {
  const attachments: AutoImageAttachment[] = [];
  for (const path of deps.resolve(text)) {
    const loaded = await deps.loadImage(path);
    if (loaded.ok) {
      attachments.push(loaded.attachment);
    }
  }
  return attachments;
}
