import { defineConfig } from "vitest/config";

// vitest 4 dropped `**/dist/**` from its default test exclude, so the
// `tsc`-compiled copies of any `src`-colocated test files are collected
// alongside the originals — running every such test twice against stale
// compiled output. Restore the exclude.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    // The windows-latest runner is 3-6x slower than a dev Mac (fsync, spawn,
    // Add-Type); the 5s default turns ordinarily-fast suites into flakes
    // there. On other platforms 15s absorbs CPU starvation when several
    // agent loops run vitest concurrently — linear one-liner tests were
    // hitting the 5s default purely from oversubscription, not test cost.
    testTimeout: process.platform === "win32" ? 30_000 : 15_000
  }
});
