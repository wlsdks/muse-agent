import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@muse/shared/browser": fileURLToPath(
        new URL("../../packages/shared/src/browser.ts", import.meta.url)
      )
    }
  },
  optimizeDeps: {
    include: ["@tanstack/react-query"]
  },
  plugins: [react()],
  test: {
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright()
    },
    include: ["src/**/*.browser.test.tsx"]
  }
});
