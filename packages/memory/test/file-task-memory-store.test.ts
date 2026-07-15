import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { TaskState } from "../src/index.js";
import { FileTaskMemoryStore } from "../src/memory-task-store.js";

describe("FileTaskMemoryStore — cross-session task persistence (CLI default-store fix)", () => {
  let dirs: string[] = [];
  const freshFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "muse-taskmem-"));
    dirs.push(dir);
    return join(dir, "task-memory.json");
  };
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  it("a task saved by one instance is found by a FRESH instance on the same file, with nested Dates round-tripped", async () => {
    const file = freshFile();
    const task: TaskState = {
      taskId: "t1",
      sessionId: "sess-1",
      userId: "u1",
      goal: "ship the parity fix",
      status: "active",
      plan: [{ step: "write the file store", updatedAt: new Date(1000) }],
      decisions: [{ summary: "use a JSON file", reason: "no DB in CLI", decidedAt: new Date(900) }],
      blockers: [{ description: "nested date serialization", owner: "me", createdAt: new Date(800) }],
      createdAt: new Date(500),
      updatedAt: new Date() // recent ⇒ not expired by the retention window
    };
    await new FileTaskMemoryStore({ file }).save(task);

    // a brand-new instance = a new `muse ask`/`chat` PROCESS reading the same file
    const byId = await new FileTaskMemoryStore({ file }).findById("t1");
    expect(byId?.goal).toBe("ship the parity fix");
    expect(byId?.plan?.[0]?.updatedAt?.getTime()).toBe(1000);      // nested plan Date round-trips
    expect(byId?.decisions?.[0]?.decidedAt?.getTime()).toBe(900);  // nested decision Date
    expect(byId?.blockers?.[0]?.createdAt?.getTime()).toBe(800);   // nested blocker Date
    expect(byId?.createdAt?.getTime()).toBe(500);

    // the active-session index is rebuilt on hydrate ⇒ cross-session active lookup works
    const active = await new FileTaskMemoryStore({ file }).findActiveBySession("sess-1", "u1");
    expect(active?.taskId).toBe("t1");
  });

  it("purgeTerminalOlderThan persists across instances; a missing file yields no task (never throws)", async () => {
    const file = freshFile();
    await new FileTaskMemoryStore({ file }).save({
      taskId: "t-done", sessionId: "s9", goal: "old work", status: "completed",
      plan: [{ step: "done" }], createdAt: new Date(1000), updatedAt: new Date(1000)
    });

    const purged = await new FileTaskMemoryStore({ file }).purgeTerminalOlderThan(new Date(5000));
    expect(purged).toBe(1);
    expect(await new FileTaskMemoryStore({ file }).findById("t-done")).toBeUndefined();

    // unwritten file ⇒ undefined, no throw
    expect(await new FileTaskMemoryStore({ file: join(tmpdir(), `muse-absent-task-${Date.now().toString()}.json`) }).findById("x")).toBeUndefined();
  });

  it("serializes concurrent read-modify-write saves from separate instances on the same file", async () => {
    const file = freshFile();
    const now = new Date();
    const first: TaskState = {
      taskId: "concurrent-first", sessionId: "concurrent-1", goal: "keep the first update", status: "active",
      plan: [], createdAt: now, updatedAt: now
    };
    const second: TaskState = {
      taskId: "concurrent-second", sessionId: "concurrent-2", goal: "keep the second update", status: "active",
      plan: [], createdAt: now, updatedAt: now
    };

    await Promise.all([
      new FileTaskMemoryStore({ file }).save(first),
      new FileTaskMemoryStore({ file }).save(second)
    ]);

    const reader = new FileTaskMemoryStore({ file });
    await expect(reader.findById(first.taskId)).resolves.toMatchObject({ goal: first.goal });
    await expect(reader.findById(second.taskId)).resolves.toMatchObject({ goal: second.goal });
  });
});
