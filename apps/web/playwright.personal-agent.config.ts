import { defineConfig, devices } from "@playwright/test";

const apiUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_API_URL");
const webUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_WEB_URL");
const browserExecutable = requiredEnvironment("MUSE_PERSONAL_AGENT_BROWSER_EXECUTABLE");
const artifactDir = requiredEnvironment("MUSE_PERSONAL_AGENT_ARTIFACT_DIR");

export default defineConfig({
  fullyParallel: false,
  outputDir: artifactDir,
  projects: [
    {
      name: "personal-agent-chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: browserExecutable }
      }
    }
  ],
  reporter: [["list"]],
  testDir: "./e2e/personal-agent",
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "pnpm --filter @muse/api dev",
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: new URL(apiUrl).port
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `${apiUrl}/ready`
    },
    {
      command: `pnpm --filter @muse/web exec vite --host 127.0.0.1 --port ${new URL(webUrl).port} --strictPort`,
      env: process.env,
      reuseExistingServer: false,
      timeout: 120_000,
      url: webUrl
    }
  ],
  workers: 1
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set by the owned personal-agent E2E runner`);
  return value;
}

function requiredLoopbackUrl(name: string): string {
  const value = requiredEnvironment(name);
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
    throw new Error(`${name} must be an explicit http://127.0.0.1:<port> URL`);
  }
  return parsed.origin;
}
