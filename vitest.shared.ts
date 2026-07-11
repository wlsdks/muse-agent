import { defineConfig } from "vitest/config";

// vitest 4 dropped `**/dist/**` from its default test exclude, so the
// `tsc`-compiled copies of any `src`-colocated test files are collected
// alongside the originals — running every such test twice against stale
// compiled output. Restore the exclude.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    // The windows-latest runner is 3-6x slower than a dev Mac (fsync, spawn,
    // Add-Type); the 5s default turns ordinarily-fast suites into flakes there.
    ...(process.platform === "win32" ? { testTimeout: 30_000 } : {})
  }
});
