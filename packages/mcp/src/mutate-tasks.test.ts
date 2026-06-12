import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mutateTasks, readTasks, writeTasks } from "./personal-tasks-store.js";
import type { PersistedTask } from "./personal-tasks-store.js";

const t = (id: string): PersistedTask => ({
  createdAt: "2026-06-12T00:00:00.000Z",
  id,
  status: "open",
  title: `task ${id}`
});

const file = () => join(mkdtempSync(join(tmpdir(), "muse-task-")), "tasks.json");

describe("mutateTasks — serialized read-modify-write (no lost write under concurrency)", () => {
  it("two concurrent adds both persist (the daemon-vs-chat race)", async () => {
    const f = file();
    await writeTasks(f, []);
    await Promise.all([
      mutateTasks(f, (cur) => [...cur, t("A")]),
      mutateTasks(f, (cur) => [...cur, t("B")])
    ]);
    expect((await readTasks(f)).map((x) => x.id).sort()).toEqual(["A", "B"]);
  });

  it("returns the post-mutation list and persists it", async () => {
    const f = file();
    await writeTasks(f, [t("X")]);
    const next = await mutateTasks(f, (cur) => cur.filter((x) => x.id !== "X"));
    expect(next).toEqual([]);
    expect(await readTasks(f)).toEqual([]);
  });

  it("a serial sequence of adds keeps every entry", async () => {
    const f = file();
    await writeTasks(f, []);
    for (const id of ["1", "2", "3", "4", "5"]) {
      await mutateTasks(f, (cur) => [...cur, t(id)]);
    }
    expect((await readTasks(f)).map((x) => x.id).sort()).toEqual(["1", "2", "3", "4", "5"]);
  });
});
