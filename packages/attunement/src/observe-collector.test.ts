import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createObserveCollector } from "./observe-collector.js";
import { createPersonalThread } from "./attunement-store.js";
import { pauseObserveSession, readObserveState, startObserveSession } from "./observe-store.js";

const directories: string[] = [];
const SESSION_ID = "observe_00000000-0000-4000-8000-000000000001";
const THREAD_ID = "thread_a";

async function setup(): Promise<{ readonly attunementFile: string; readonly file: string }> {
  const directory = await mkdtemp(join(tmpdir(), "muse-observe-host-"));
  directories.push(directory);
  const file = join(directory, "observe.json");
  const attunementFile = join(directory, "attunement.json");
  await createPersonalThread(attunementFile, { kind: "work", title: "Thread" }, { idFactory: () => "a" });
  await startObserveSession(file, { acceptVersion: 1, threadId: THREAD_ID }, {
    idFactory: () => SESSION_ID,
    now: () => new Date("2026-07-22T00:00:00.000Z")
  });
  return { attunementFile, file };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("host-only Observe collector", () => {
  it("fences a second live collector without exposing owner or token", async () => {
    const { attunementFile, file } = await setup();
    const first = createObserveCollector({
      attunementFile,
      file,
      intervalMs: 10_000,
      now: () => new Date("2026-07-22T00:00:01.000Z"),
      sessionId: SESSION_ID,
      threadId: THREAD_ID
    });
    const second = createObserveCollector({
      attunementFile,
      file,
      intervalMs: 10_000,
      now: () => new Date("2026-07-22T00:00:02.000Z"),
      sessionId: SESSION_ID,
      threadId: THREAD_ID
    });
    await expect(first.claim()).resolves.toBeUndefined();
    await expect(second.claim()).rejects.toMatchObject({ code: "conflict" });
    expect(Object.keys(first).sort()).toEqual(["claim", "release", "renew", "sample"]);
    await first.sample("writing");
    expect((await readObserveState(file)).activeSegments[0]?.appCategory).toBe("writing");
  });

  it("invalidates a collector when the user pauses its session", async () => {
    const { attunementFile, file } = await setup();
    const collector = createObserveCollector({
      attunementFile,
      file,
      intervalMs: 10_000,
      now: () => new Date("2026-07-22T00:00:01.000Z"),
      sessionId: SESSION_ID,
      threadId: THREAD_ID
    });
    await collector.claim();
    await pauseObserveSession(file, SESSION_ID, { now: () => new Date("2026-07-22T00:00:02.000Z") });
    await expect(collector.sample("writing")).rejects.toMatchObject({ code: "conflict" });
    await expect(collector.release()).resolves.toBeUndefined();
  });
});
