import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createObserveCollector } from "./observe-collector.js";
import { pauseObserveSession, readObserveState, startObserveSession } from "./observe-store.js";

const directories: string[] = [];
const SESSION_ID = "observe_00000000-0000-4000-8000-000000000001";

async function setup(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-observe-host-"));
  directories.push(directory);
  const file = join(directory, "observe.json");
  await startObserveSession(file, { acceptVersion: 1, threadId: "thread-a" }, {
    idFactory: () => SESSION_ID,
    now: () => new Date("2026-07-22T00:00:00.000Z")
  });
  return file;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("host-only Observe collector", () => {
  it("fences a second live collector without exposing owner or token", async () => {
    const file = await setup();
    const first = createObserveCollector({
      assertKnownThread: async () => undefined,
      file,
      intervalMs: 10_000,
      now: () => new Date("2026-07-22T00:00:01.000Z"),
      sessionId: SESSION_ID,
      threadId: "thread-a"
    });
    const second = createObserveCollector({
      assertKnownThread: async () => undefined,
      file,
      intervalMs: 10_000,
      now: () => new Date("2026-07-22T00:00:02.000Z"),
      sessionId: SESSION_ID,
      threadId: "thread-a"
    });
    await expect(first.claim()).resolves.toBeUndefined();
    await expect(second.claim()).rejects.toMatchObject({ code: "conflict" });
    expect(Object.keys(first).sort()).toEqual(["claim", "release", "renew", "sample"]);
    await first.sample("writing");
    expect((await readObserveState(file)).activeSegments[0]?.appCategory).toBe("writing");
  });

  it("invalidates a collector when the user pauses its session", async () => {
    const file = await setup();
    const collector = createObserveCollector({
      assertKnownThread: async () => undefined,
      file,
      intervalMs: 10_000,
      now: () => new Date("2026-07-22T00:00:01.000Z"),
      sessionId: SESSION_ID,
      threadId: "thread-a"
    });
    await collector.claim();
    await pauseObserveSession(file, SESSION_ID, { now: () => new Date("2026-07-22T00:00:02.000Z") });
    await expect(collector.sample("writing")).rejects.toMatchObject({ code: "conflict" });
    await expect(collector.release()).resolves.toBeUndefined();
  });
});
