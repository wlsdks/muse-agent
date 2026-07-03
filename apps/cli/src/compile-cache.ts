/**
 * Enables Node's V8 compile cache (stable since Node 22.1, no flag needed on
 * Node 24) so the ~100-module command graph `program.ts` pulls in is loaded
 * from compiled bytecode on every `muse` invocation after the first, instead
 * of being re-parsed from source every time.
 *
 * This module must be the FIRST import in `index.ts` — before `muse-spec.js`
 * / `muse-version.js` and, more importantly, before `program.ts` is
 * dynamically imported. ES module imports execute in declaration order
 * before the importing module's own body runs, so importing this file first
 * (with no imports of its own) guarantees the cache is enabled before any
 * other Muse module in the graph is compiled.
 *
 * No cache directory is pinned here: calling `enableCompileCache()` with no
 * argument lets Node use `NODE_COMPILE_CACHE` when set, otherwise its own
 * per-Node-version OS-temp-dir default — so a Node/V8 upgrade can't serve a
 * stale cache. Best-effort only: a read-only or sandboxed filesystem must
 * never crash the CLI, so failures are swallowed.
 */
import { enableCompileCache } from "node:module";

export function enableCliCompileCache(): void {
  try {
    enableCompileCache();
  } catch {
    // Best-effort only — never block CLI startup on cache-directory issues.
  }
}

enableCliCompileCache();
