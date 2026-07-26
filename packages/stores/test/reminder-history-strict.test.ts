import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendReminderHistory,
  appendReminderHistoryStrictOnce,
  readReminderHistoryStrict,
  type ReminderHistoryEntry
} from "../src/index.js";

function fixture(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-reminder-history-strict-")), "history.json");
}

function entry(id: string): ReminderHistoryEntry {
  return {
    destination: "@owner",
    effectId: `reminder:effect-${id}`,
    firedAtIso: `2026-07-27T00:00:0${id}.000Z`,
    providerId: "telegram",
    reminderId: `rem-${id}`,
    status: "delivered",
    text: `reminder ${id}`
  };
}

describe("readReminderHistoryStrict", () => {
  it("returns missing as empty and valid entries newest-first with a bounded limit", async () => {
    const file = fixture();
    expect(await readReminderHistoryStrict(file)).toEqual([]);
    await appendReminderHistory(file, entry("1"));
    await appendReminderHistory(file, entry("2"));
    expect(await readReminderHistoryStrict(file, 1)).toEqual([expect.objectContaining({ reminderId: "rem-2" })]);
  });

  it("fails closed on corrupt bytes without quarantining or changing them", async () => {
    const file = fixture();
    const corrupt = "{not-json";
    writeFileSync(file, corrupt, { mode: 0o600 });
    await expect(readReminderHistoryStrict(file)).rejects.toThrow("history is corrupt");
    expect(readFileSync(file, "utf8")).toBe(corrupt);
    expect(existsSync(file)).toBe(true);
  });

  it.each([
    { entries: [], version: 2 },
    { entries: [{ nope: true }], version: 1 },
    { version: 1 },
    { entries: [], extra: true, version: 1 },
    {
      entries: [{ ...entry("1"), effectId: "x".repeat(513) }],
      version: 1
    }
  ])("rejects unsupported persisted shapes", async (shape) => {
    const file = fixture();
    writeFileSync(file, JSON.stringify(shape), { mode: 0o600 });
    await expect(readReminderHistoryStrict(file)).rejects.toThrow("unsupported schema");
  });
});

describe("appendReminderHistoryStrictOnce", () => {
  it("deduplicates only an exact effectId and rejects conflicting content without changing bytes", async () => {
    const file = fixture();
    const original = entry("1");
    expect(await appendReminderHistoryStrictOnce(file, original)).toBe("appended");
    const before = readFileSync(file, "utf8");
    expect(await appendReminderHistoryStrictOnce(file, original)).toBe("existing");
    expect(readFileSync(file, "utf8")).toBe(before);

    await expect(appendReminderHistoryStrictOnce(file, {
      ...original,
      text: "conflicting factual text"
    })).rejects.toThrow("effectId is bound to different content");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("keeps distinct effects even when every legacy delivery field and receipt time coincide", async () => {
    const file = fixture();
    const first = entry("1");
    const second = { ...first, effectId: "reminder:effect-2" };
    await appendReminderHistoryStrictOnce(file, first);
    await appendReminderHistoryStrictOnce(file, second);
    expect(await readReminderHistoryStrict(file)).toEqual([second, first]);
  });

  it("fails closed on corrupt bytes and requires a bounded exact effectId", async () => {
    const file = fixture();
    const corrupt = "{not-json";
    writeFileSync(file, corrupt, { mode: 0o600 });
    await expect(appendReminderHistoryStrictOnce(file, entry("1"))).rejects.toThrow("history is corrupt");
    expect(readFileSync(file, "utf8")).toBe(corrupt);

    const missingEffect = { ...entry("2"), effectId: undefined };
    await expect(appendReminderHistoryStrictOnce(fixture(), missingEffect)).rejects.toThrow("requires an effectId");
  });

  it("can re-record a trimmed effect without conflating it with retained occurrences", async () => {
    const file = fixture();
    await appendReminderHistoryStrictOnce(file, entry("1"), { capacity: 2 });
    await appendReminderHistoryStrictOnce(file, entry("2"), { capacity: 2 });
    await appendReminderHistoryStrictOnce(file, entry("3"), { capacity: 2 });
    expect((await readReminderHistoryStrict(file)).map(({ effectId }) => effectId)).toEqual([
      "reminder:effect-3",
      "reminder:effect-2"
    ]);
    expect(await appendReminderHistoryStrictOnce(file, entry("1"), { capacity: 2 })).toBe("appended");
    expect((await readReminderHistoryStrict(file)).map(({ effectId }) => effectId)).toEqual([
      "reminder:effect-1",
      "reminder:effect-3"
    ]);
  });
});
