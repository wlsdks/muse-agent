/**
 * MED-12 — extract image SOURCES (URLs + local paths) from freeform text
 * for vision routing. `muse ask --image` takes an explicit path today; this
 * is the deterministic extractor a future auto-route can build on.
 *
 * URLs reuse the SSRF-safe {@link extractPublicHttpUrls} (a private/loopback
 * lure never qualifies) and are filtered to image extensions. Local paths
 * are deliberately CONSERVATIVE — only path-shaped tokens (a `/`, `~/`,
 * `./`, `../` prefix) ending in an image extension qualify, so a bare
 * filename mentioned in prose ("see config.png") is NOT treated as an
 * attachment. Pure + synchronous; never reads the filesystem (a caller
 * still gates a path through fs-path-safety before loading it).
 */

import { extractPublicHttpUrls } from "./web-url-guard.js";

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|heic)(?:[?#]\S*)?$/iu;
const LOCAL_IMAGE_PATH_RE =
  /(?:^|\s)((?:(?:~|\.{0,2})\/|[A-Za-z]:[\\/])[^\s'"<>]*?\.(?:png|jpe?g|gif|webp|bmp|svg|heic))(?=$|[\s'"<>)])/giu;

export interface ImageSources {
  readonly urls: readonly string[];
  readonly paths: readonly string[];
}

export interface ImageAttachmentResolveDeps {
  /** True when the path is NOT a sensitive/denied location (wire fs-path-safety). */
  readonly isPathSafe: (path: string) => boolean;
  /** True when the path exists on disk and is a readable file. */
  readonly fileExists: (path: string) => boolean;
}

/**
 * The LOCAL image paths in `text` that are SAFE to auto-attach: detected by
 * {@link extractImageSources}, then gated to those that pass the injected
 * path-safety check AND exist on disk. Both gates are required — a path-shaped
 * token in prose that doesn't resolve, or one under a sensitive dir, is
 * dropped. Pure (filesystem + safety injected) so an auto-attach flow has a
 * deterministic, testable candidate list and never reads an unvetted path.
 */
export function resolveImageAttachmentCandidates(text: string, deps: ImageAttachmentResolveDeps): string[] {
  return extractImageSources(text).paths.filter((path) => deps.isPathSafe(path) && deps.fileExists(path));
}

export function extractImageSources(text: string): ImageSources {
  const urls = extractPublicHttpUrls(text).filter((url) => IMAGE_EXT_RE.test(url));
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(LOCAL_IMAGE_PATH_RE)) {
    const path = match[1]!;
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return { paths, urls };
}
