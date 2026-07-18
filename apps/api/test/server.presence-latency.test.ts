import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { withFileLock } from "@muse/stores";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../src/server.js";

type BuildServerOptions = NonNullable<Parameters<typeof buildServer>[0]>;

async function waitForPersistedActivity(file: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { readonly lastActivityMs?: unknown };
      if (
        typeof parsed.lastActivityMs === "number"
        && Number.isFinite(parsed.lastActivityMs)
        && parsed.lastActivityMs >= 0
        && parsed.lastActivityMs <= Date.now()
      ) {
        return parsed.lastActivityMs;
      }
    } catch {
      // The non-blocking hook may still be waiting for the held lock.
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for valid activity in ${file}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("API chat presence hook", () => {
  it("does not hold a chat request behind best-effort presence persistence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-presence-hook-latency-"));
    const presenceFile = join(dir, "presence.json");
    vi.stubEnv("MUSE_PROACTIVE_AGENT_TURN", "true");
    vi.stubEnv("MUSE_PROACTIVE_PRESENCE_FILE", presenceFile);

    const server = buildServer({
      agentRuntime: {} as NonNullable<BuildServerOptions["agentRuntime"]>,
      defaultModel: "test/model",
      logger: false
    });
    let releaseLock: (() => void) | undefined;
    let lockHolder: Promise<void> | undefined;
    let request: ReturnType<typeof server.inject> | undefined;
    try {
      await server.ready();
      let reportAcquired!: () => void;
      const acquired = new Promise<void>((resolve) => { reportAcquired = resolve; });
      const held = new Promise<void>((resolve) => { releaseLock = resolve; });
      lockHolder = withFileLock(presenceFile, async () => {
        reportAcquired();
        await held;
      });
      await Promise.race([
        acquired,
        lockHolder.then(() => { throw new Error("presence lock holder ended before acquisition"); })
      ]);

      request = server.inject({ method: "GET", url: "/api/chat" });
      const completedWhileLocked = await Promise.race([
        request.then(() => true),
        delay(2_000).then(() => false)
      ]);
      expect(completedWhileLocked).toBe(true);

      releaseLock();
      releaseLock = undefined;
      await lockHolder;
      await request;
      expect(await waitForPersistedActivity(presenceFile)).toBeGreaterThan(0);
    } finally {
      releaseLock?.();
      await Promise.allSettled([
        ...(lockHolder ? [lockHolder] : []),
        ...(request ? [request] : [])
      ]);
      await server.close();
    }
  });
});
