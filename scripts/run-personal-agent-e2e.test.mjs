import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPersonalAgentE2eEnvironment } from "./run-personal-agent-e2e.mjs";

test("personal-agent E2E environment is sparse, local-only, and owner-secret free", () => {
  const env = createPersonalAgentE2eEnvironment({
    apiPort: 41001,
    browserExecutable: "/opt/browser/chromium",
    sourceEnv: {
      HOME: "/Users/owner",
      OPENAI_API_KEY: "owner-secret",
      PATH: "/usr/bin:/bin"
    },
    stateRoot: "/tmp/muse-personal-agent-fixture",
    webPort: 41002
  });

  assert.equal(env.HOME, "/tmp/muse-personal-agent-fixture/home");
  assert.equal(env.MUSE_LOCAL_ONLY, "true");
  assert.match(env.MUSE_MODEL, /^diagnostic\//u);
  assert.equal(env.MUSE_PERSONAL_AGENT_API_URL, "http://127.0.0.1:41001");
  assert.equal(env.MUSE_PERSONAL_AGENT_WEB_URL, "http://127.0.0.1:41002");
  assert.equal(env.MUSE_CORS_ALLOWED_ORIGINS, "http://127.0.0.1:41002");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(JSON.stringify(env).includes("owner-secret"), false);
  assert.equal(JSON.stringify(env).includes("/Users/owner"), false);
});

test("runner and Playwright config forbid server reuse and broad process cleanup", async () => {
  const runner = await readFile(new URL("./run-personal-agent-e2e.mjs", import.meta.url), "utf8");
  const changedTestRunner = await readFile(new URL("./test-changed.mjs", import.meta.url), "utf8");
  const config = await readFile(
    new URL("../apps/web/playwright.personal-agent.config.ts", import.meta.url),
    "utf8"
  );

  assert.match(config, /reuseExistingServer:\s*false/gu);
  assert.match(config, /127\.0\.0\.1/gu);
  assert.match(config, /strictPort/gu);
  assert.doesNotMatch(runner, /\b(?:pkill|killall)\b|process\.kill\(\s*-/u);
  assert.match(runner, /bindOwnedProcessGroup/u);
  assert.match(runner, /forceOwnedProcessGroup/u);
  assert.match(runner, /muse-personal-agent-e2e-/u);
  assert.match(changedTestRunner, /e2e\/personal-agent\//u);
  assert.match(changedTestRunner, /test:e2e:personal-agent/u);
});
