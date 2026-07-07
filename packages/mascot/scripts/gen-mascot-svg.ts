/**
 * Regenerates the README animated mascot straight from the canonical pixel
 * data — zero hand-drawn assets, single source of truth. Run it whenever the
 * mascot's pixel data changes:
 *
 *   pnpm --filter @muse/mascot gen:svg
 *
 * Output: docs/assets/mascot.svg (committed, but GENERATED — never edit by
 * hand). The SVG animates via self-contained CSS keyframes so it moves inside
 * a GitHub README `<img>`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toSvg } from "../src/to-svg.js";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, "../../../docs/assets/mascot.svg");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, toSvg({ size: 128 }));
console.log(`wrote ${outFile}`);
