import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "MUSE_MODEL=diagnostic/smoke MUSE_MODEL_PROVIDER_ID=diagnostic PORT=3001 pnpm --filter @muse/api dev",
      reuseExistingServer: true,
      timeout: 120_000,
      url: "http://127.0.0.1:3001/health"
    },
    {
      command: "pnpm --filter @muse/web dev -- --port 5173",
      reuseExistingServer: true,
      timeout: 120_000,
      url: "http://127.0.0.1:5173"
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
