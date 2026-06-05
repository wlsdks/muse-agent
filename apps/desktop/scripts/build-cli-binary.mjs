// Compile the Muse CLI into a single self-contained binary (bun runtime baked in)
// for bundling inside MuseDesktop.app, so the companion needs no external node /
// repo / node_modules. Dev-only optional deps (react-devtools-core, used by ink
// only under a devtools env) are stubbed so they don't need to resolve at runtime.
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const entry = resolve(repoRoot, "apps/cli/dist/index.js");
const outfile = process.argv[2] ?? resolve(repoRoot, "apps/desktop/.build/muse-cli-bin");

const stub = {
  name: "stub-optional-dev-deps",
  setup(build) {
    // ink pulls react-devtools-core at import time; it's only used under a dev flag.
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "rdc", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default {}; export const connectToDevTools = () => {};",
      loader: "js"
    }));
  }
};

const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  compile: { outfile },
  plugins: [stub]
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("built", outfile);
