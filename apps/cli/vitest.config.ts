import { defineConfig } from "vitest/config";

// vitest 4 dropped `**/dist/**` from its default test exclude, so the
// `tsc`-compiled `dist/**/*.test.js` copies are collected alongside the
// `src` originals — every test runs twice (against stale compiled code)
// and the doubled parallel fs load makes real-/tmp tests flake. Restore
// the exclude so only `src` tests run.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});
