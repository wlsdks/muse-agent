import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mutateReminders, readReminders, writeReminders } from "@muse/stores";
import type { PersistedReminder } from "@muse/stores";

const r = (id: string): PersistedReminder => ({
  createdAt: "2026-06-12T00:00:00.000Z",
  dueAt: "2026-06-13T00:00:00.000Z",
  id,
  status: "pending",
  text: `reminder ${id}`
});

const file = () => join(mkdtempSync(join(tmpdir(), "muse-rem-")), "reminders.json");

describe("mutateReminders — serialized read-modify-write (no lost write under concurrency)", () => {
  it("two concurrent adds both persist (the firing-loop-vs-chat race)", async () => {
    const f = file();
    await writeReminders(f, []);
    // Both start from the same empty store; an unserialized RMW would lose one.
    await Promise.all([
      mutateReminders(f, (cur) => [...cur, r("A")]),
      mutateReminders(f, (cur) => [...cur, r("B")])
    ]);
    const ids = (await readReminders(f)).map((x) => x.id).sort();
    expect(ids).toEqual(["A", "B"]);
  });

  it("returns the post-mutation list and persists it", async () => {
    const f = file();
    await writeReminders(f, [r("X")]);
    const next = await mutateReminders(f, (cur) => cur.filter((x) => x.id !== "X"));
    expect(next).toEqual([]);
    expect(await readReminders(f)).toEqual([]);
  });

  it("a serial sequence of adds keeps every entry", async () => {
    const f = file();
    await writeReminders(f, []);
    for (const id of ["1", "2", "3", "4", "5"]) {
      await mutateReminders(f, (cur) => [...cur, r(id)]);
    }
    expect((await readReminders(f)).map((x) => x.id).sort()).toEqual(["1", "2", "3", "4", "5"]);
  });
});
