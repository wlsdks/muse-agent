import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider } from "@muse/model";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../src/server.js";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const AFTER_ONE_TICK = new Date(NOW.getTime() + 60_000);

describe("assembled self-improvement live status", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the real interval tick's safe idle deferral without model or write work", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["clearInterval", "Date", "setInterval"] });
    const root = mkdtempSync(join(tmpdir(), "muse-self-improvement-live-status-"));
    const authoredSkillsDir = join(root, "authored-skills");
    const generate = vi.fn(async () => ({ output: "unused" }));
    const server = buildServer({
      defaultModel: "fake-model",
      env: {
        MUSE_AUTHORED_SKILLS_DIR: authoredSkillsDir,
        MUSE_DAEMON_SETTINGS_FILE: join(root, "daemon-settings.json"),
        MUSE_LEARN_QUEUE_FILE: join(root, "learn-queue.jsonl"),
        MUSE_LEARNING_PAUSE_FILE: join(root, "learning-paused.json"),
        MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "true",
        MUSE_SKILL_CONSOLIDATE_TICK_MS: "60000"
      },
      logger: false,
      modelProvider: { generate } as unknown as ModelProvider
    });

    try {
      const before = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({
        configured: true,
        enabled: true,
        lastDecision: null,
        lastObservedAtIso: null,
        state: "running"
      });

      await vi.advanceTimersByTimeAsync(59_999);
      const beforeInterval = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
      expect(beforeInterval.json()).toMatchObject({ lastDecision: null, lastObservedAtIso: null });

      await vi.advanceTimersByTimeAsync(1);
      const after = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
      expect(after.json()).toMatchObject({
        configured: true,
        enabled: true,
        lastDecision: "waiting-for-idle",
        lastObservedAtIso: AFTER_ONE_TICK.toISOString(),
        state: "running"
      });
      expect(generate).not.toHaveBeenCalled();
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      await server.close();
    }

    expect(vi.getTimerCount()).toBe(0);
  });
});
