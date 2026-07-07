/**
 * Drift guard: `apps/web` is deliberately OUT of the TypeScript project-
 * reference graph (a Vite island with no `@muse/*` deps), so it keeps a LOCAL
 * copy of the mascot pixel data in `pixel-bird.ts`. The CANONICAL source is
 * `@muse/mascot`. This test reads the canonical file as TEXT (never imports
 * it — that would pull the package into web's graph) and asserts every pixel-
 * art matrix row is byte-identical between the two. Mutate a matrix in either
 * file and this goes RED.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SOURCE = resolve(HERE, "pixel-bird.ts");
const CANONICAL_SOURCE = resolve(HERE, "../../../../packages/mascot/src/pixel-data.ts");

/**
 * Extract every pixel-art matrix row (strings made only of the drawing
 * charset), in file order. This deliberately ignores palette hex values,
 * `"transparent"`, and the lowercase pose-name union — only the actual art.
 */
function extractMatrixRows(source: string): string[] {
  return [...source.matchAll(/"([.BSWKCATLZNH]{2,13})"/g)].map((m) => m[1]!);
}

describe("mascot pixel-data drift guard", () => {
  it("web pixel-bird.ts matrices are byte-identical to @muse/mascot's canonical source", () => {
    const webRows = extractMatrixRows(readFileSync(WEB_SOURCE, "utf8"));
    const canonicalRows = extractMatrixRows(readFileSync(CANONICAL_SOURCE, "utf8"));

    // Sanity: we actually captured the art (17 poses x 11 rows + overlays).
    expect(webRows.length).toBeGreaterThan(180);
    expect(webRows).toEqual(canonicalRows);
  });
});
