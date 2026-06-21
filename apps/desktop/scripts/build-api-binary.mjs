// Compile the Muse API server into a single self-contained binary (bun runtime
// baked in) for bundling inside Muse.app, so the desktop app can run the FULL
// Muse experience — every web panel + the API — with no external node / repo /
// node_modules. Mirrors build-cli-binary.mjs.
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const entry = resolve(repoRoot, "apps/api/dist/index.js");
const outfile = process.argv[2] ?? resolve(repoRoot, "apps/desktop/.build/muse-api-bin");

const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  compile: { outfile }
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("built", outfile);
