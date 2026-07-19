import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  markReconfirmCardAnswered,
  reconfirmCardAlreadyAnsweredToday,
  readReconfirmCardAnsweredDate
} from "./reconfirm-card-answered-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reconfirm-card-answered-"));
  file = join(dir, "reconfirm-card-answered.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("reconfirm-card-answered-store", () => {
  it("reads undefined when the file does not exist", async () => {
    expect(await readReconfirmCardAnsweredDate(file)).toBeUndefined();
    expect(await reconfirmCardAlreadyAnsweredToday(file, new Date("2026-07-16T09:00:00.000Z"))).toBe(false);
  });

  it("records the local date on mark, and reads it back", async () => {
    const at = new Date("2026-07-16T09:00:00.000Z");
    await markReconfirmCardAnswered(file, at);
    const stored = await readReconfirmCardAnsweredDate(file);
    expect(stored).toBe(`${at.getFullYear().toString()}-${(at.getMonth() + 1).toString().padStart(2, "0")}-${at.getDate().toString().padStart(2, "0")}`);
  });

  it("reports already-answered-today true on the SAME local date, false on a different one", async () => {
    // Local-time constructors (not UTC ISO strings) so the "same calendar
    // day" assertion holds regardless of the machine's timezone offset.
    const morning = new Date(2026, 6, 16, 1, 0, 0);
    await markReconfirmCardAnswered(file, morning);
    const laterSameDay = new Date(2026, 6, 16, 20, 0, 0);
    expect(await reconfirmCardAlreadyAnsweredToday(file, laterSameDay)).toBe(true);
    const nextDay = new Date(2026, 6, 17, 1, 0, 0);
    expect(await reconfirmCardAlreadyAnsweredToday(file, nextDay)).toBe(false);
  });

  it("tolerates malformed JSON — treated as never answered", async () => {
    const { atomicWriteFile } = await import("./atomic-file-store.js");
    await atomicWriteFile(file, "not json");
    expect(await readReconfirmCardAnsweredDate(file)).toBeUndefined();
    expect(await reconfirmCardAlreadyAnsweredToday(file, new Date())).toBe(false);
  });

  it("tolerates a missing lastAnsweredDate field", async () => {
    const { atomicWriteFile } = await import("./atomic-file-store.js");
    await atomicWriteFile(file, JSON.stringify({ notTheRightField: true }));
    expect(await readReconfirmCardAnsweredDate(file)).toBeUndefined();
  });
});
