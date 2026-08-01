import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  firedKey,
  legacyCalendarWildcardKey,
  ProactiveFiredStoreError,
  readProactiveFired,
  readSessionLock,
  writeProactiveFired,
  writeSessionLock,
  type LegacyCalendarProactiveFiredEntry,
  type ProactiveFiredEntry,
  type QualifiedCalendarProactiveFiredEntry,
  type TaskProactiveFiredEntry
} from "../src/proactive-notice-store.js";

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "muse-proactive-store-")), name);
}

describe("session lock (writeSessionLock / readSessionLock)", () => {
  it("returns the until ISO while the lock is active, undefined once it expires", async () => {
    const file = tmpFile("lock.json");
    const until = new Date("2026-06-14T18:00:00Z").toISOString();
    await writeSessionLock(file, { until, setAt: new Date("2026-06-14T12:00:00Z").toISOString() });
    expect(await readSessionLock(file, new Date("2026-06-14T15:00:00Z"))).toBe(until); // before until
    expect(await readSessionLock(file, new Date("2026-06-14T18:00:01Z"))).toBeUndefined(); // past until
  });

  it("returns undefined for a missing lock file (fail-soft)", async () => {
    expect(await readSessionLock(tmpFile("absent.json"), new Date())).toBeUndefined();
  });
});

describe("fired ledger (writeProactiveFired / readProactiveFired)", () => {
  const legacyCalendar: LegacyCalendarProactiveFiredEntry = {
    kind: "calendar",
    id: "evt-1",
    startIso: "2026-06-14T18:00:00.000Z",
    firedAt: "2026-06-14T17:30:00.000Z"
  };
  const qualifiedCalendar: QualifiedCalendarProactiveFiredEntry = {
    firedAt: "2026-06-14T17:31:00.000Z",
    id: "evt-1",
    kind: "calendar",
    providerEventId: "provider-event-17",
    providerId: "caldav",
    startIso: "2026-06-14T18:00:00.000Z"
  };
  const task: TaskProactiveFiredEntry = {
    firedAt: "2026-06-14T17:32:00.000Z",
    id: "task-1",
    kind: "task",
    startIso: "2026-06-14T18:05:00.000Z"
  };

  it("round-trips the discriminated union through exact v2", async () => {
    const file = tmpFile("fired.json");
    await writeProactiveFired(file, [legacyCalendar, qualifiedCalendar, task]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      fired: [legacyCalendar, qualifiedCalendar, task],
      version: 2
    });
    expect(await readProactiveFired(file)).toEqual([legacyCalendar, qualifiedCalendar, task]);
  });

  it("returns [] only for a missing file", async () => {
    expect(await readProactiveFired(tmpFile("absent.json"))).toEqual([]);
  });

  it("reads synthetic unversioned entries without rewriting or guessing provenance, then preserves them on a later normal v2 write", async () => {
    const file = tmpFile("legacy.json");
    const raw = `${JSON.stringify({ fired: [legacyCalendar, task] }, null, 2)}\n`;
    writeFileSync(file, raw, "utf8");

    const read = await readProactiveFired(file);

    expect(read).toEqual([legacyCalendar, task]);
    expect(readFileSync(file, "utf8")).toBe(raw);
    expect(read[0]).not.toHaveProperty("providerId");
    await writeProactiveFired(file, [...read, qualifiedCalendar]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      fired: [legacyCalendar, task, qualifiedCalendar],
      version: 2
    });
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["array top-level", "[]"],
    ["extra top-level key", JSON.stringify({ fired: [], owner: "hidden", version: 2 })],
    ["unknown version", JSON.stringify({ fired: [], version: 99 })],
    ["non-array fired", JSON.stringify({ fired: {}, version: 2 })],
    ["partial provenance", JSON.stringify({
      fired: [{ ...legacyCalendar, providerEventId: "raw-only" }],
      version: 2
    })],
    ["blank provider", JSON.stringify({
      fired: [{ ...legacyCalendar, providerId: " " }],
      version: 2
    })],
    ["task provenance", JSON.stringify({
      fired: [{ ...task, providerId: "calendar-on-task" }],
      version: 2
    })],
    ["whitespace-only id", JSON.stringify({
      fired: [{ ...task, id: " \t " }],
      version: 2
    })],
    ["extra entry field", JSON.stringify({
      fired: [{ ...qualifiedCalendar, title: "must not persist" }],
      version: 2
    })],
    ["unparseable timestamp", JSON.stringify({
      fired: [{ ...task, firedAt: "not-a-time" }],
      version: 2
    })],
    ["numeric-like timestamp", JSON.stringify({
      fired: [{ ...task, firedAt: "0" }],
      version: 2
    })],
    ["date-only timestamp", JSON.stringify({
      fired: [{ ...task, startIso: "2026-07-27" }],
      version: 2
    })],
    ["timestamp without canonical milliseconds", JSON.stringify({
      fired: [{ ...task, startIso: "2026-07-27T03:00:00Z" }],
      version: 2
    })],
    ["offset timestamp", JSON.stringify({
      fired: [{ ...task, startIso: "2026-07-27T12:00:00+09:00" }],
      version: 2
    })],
    ["impossible day", JSON.stringify({
      fired: [{ ...task, startIso: "2026-02-30T00:00:00.000Z" }],
      version: 2
    })],
    ["invalid leap day", JSON.stringify({
      fired: [{ ...task, startIso: "2025-02-29T00:00:00.000Z" }],
      version: 2
    })],
    ["impossible month", JSON.stringify({
      fired: [{ ...task, startIso: "2026-13-01T00:00:00.000Z" }],
      version: 2
    })],
    ["impossible time", JSON.stringify({
      fired: [{ ...task, startIso: "2026-01-01T24:01:00.000Z" }],
      version: 2
    })],
    ["timestamp with whitespace", JSON.stringify({
      fired: [{ ...task, startIso: " 2026-07-27T03:00:00.000Z" }],
      version: 2
    })]
  ])("fails closed for %s", async (_name, raw) => {
    const file = tmpFile("invalid.json");
    writeFileSync(file, raw, "utf8");
    await expect(readProactiveFired(file)).rejects.toBeInstanceOf(ProactiveFiredStoreError);
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  it("validates the whole write before replacing an existing ledger", async () => {
    const file = tmpFile("no-overwrite.json");
    await writeProactiveFired(file, [task]);
    const before = readFileSync(file, "utf8");
    const invalid = { ...qualifiedCalendar, providerId: "" } as ProactiveFiredEntry;

    await expect(writeProactiveFired(file, [task, invalid])).rejects.toBeInstanceOf(ProactiveFiredStoreError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("rejects a whitespace-only id before replacing valid bytes", async () => {
    const file = tmpFile("invalid-id-no-overwrite.json");
    await writeProactiveFired(file, [task]);
    const before = readFileSync(file, "utf8");
    const invalid = { ...task, id: " \t " };

    await expect(writeProactiveFired(file, [task, invalid])).rejects.toBeInstanceOf(ProactiveFiredStoreError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it.each([
    ["numeric-like firedAt", "firedAt", "0"],
    ["date-only startIso", "startIso", "2026-07-27"],
    ["non-canonical UTC startIso", "startIso", "2026-07-27T03:00:00Z"],
    ["offset startIso", "startIso", "2026-07-27T12:00:00+09:00"],
    ["impossible-day startIso", "startIso", "2026-02-30T00:00:00.000Z"],
    ["invalid-leap startIso", "startIso", "2025-02-29T00:00:00.000Z"],
    ["impossible-month startIso", "startIso", "2026-13-01T00:00:00.000Z"],
    ["impossible-time startIso", "startIso", "2026-01-01T24:01:00.000Z"],
    ["whitespace startIso", "startIso", " 2026-07-27T03:00:00.000Z"]
  ] as const)("rejects %s before replacing valid bytes", async (_name, field, value) => {
    const file = tmpFile("invalid-timestamp-no-overwrite.json");
    await writeProactiveFired(file, [task]);
    const before = readFileSync(file, "utf8");
    const invalid = { ...task, [field]: value } as TaskProactiveFiredEntry;

    await expect(writeProactiveFired(file, [task, invalid])).rejects.toBeInstanceOf(ProactiveFiredStoreError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("accepts an exact canonical leap-day timestamp with milliseconds", async () => {
    const file = tmpFile("valid-leap.json");
    const leap: TaskProactiveFiredEntry = {
      ...task,
      firedAt: "2024-02-29T23:59:59.999Z",
      startIso: "2024-02-29T23:59:59.999Z"
    };

    await writeProactiveFired(file, [leap]);
    expect(await readProactiveFired(file)).toEqual([leap]);
  });

  it("keeps the newest 1000 entries and writes owner-only mode", async () => {
    const file = tmpFile("capped.json");
    const entries: TaskProactiveFiredEntry[] = Array.from({ length: 1_005 }, (_, index) => ({
      firedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      id: `task-${index.toString()}`,
      kind: "task",
      startIso: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString()
    }));

    await writeProactiveFired(file, entries);
    const persisted = await readProactiveFired(file);

    expect(persisted).toHaveLength(1_000);
    expect(persisted[0]!.id).toBe("task-5");
    expect(persisted.at(-1)!.id).toBe("task-1004");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(file, ".."))).toEqual(["capped.json"]);
  });

  it("keeps task entries free of calendar provenance at the type boundary", () => {
    type TaskHasProviderId = "providerId" extends keyof TaskProactiveFiredEntry ? true : false;
    type TaskHasProviderEventId = "providerEventId" extends keyof TaskProactiveFiredEntry ? true : false;
    expectTypeOf<TaskHasProviderId>().toEqualTypeOf<false>();
    expectTypeOf<TaskHasProviderEventId>().toEqualTypeOf<false>();
  });
});

describe("firedKey", () => {
  it("rejects a whitespace-only id without normalizing meaningful nonblank ids", () => {
    expect(() => firedKey({
      id: " \t ",
      kind: "task",
      startIso: "2026-06-14T18:00:00.000Z"
    })).toThrow(/invalid id/iu);
    expect(firedKey({
      id: " meaningful ",
      kind: "task",
      startIso: "2026-06-14T18:00:00.000Z"
    })).toBe(JSON.stringify(["task", " meaningful ", "2026-06-14T18:00:00.000Z"]));
  });

  it("encodes distinct valid {kind,id,startIso} tuples unambiguously", () => {
    const a = firedKey({ kind: "task", id: "a b", startIso: "2026-06-14T18:00:00.000Z" });
    const b = firedKey({ kind: "task", id: "a", startIso: "2026-06-14T18:00:01.000Z" });
    expect(a).not.toBe(b);
  });

  it("uses exact provider occurrence identity for qualified calendars and a separate legacy wildcard", () => {
    const caldav = firedKey({
      id: "shared",
      kind: "calendar",
      providerEventId: "raw",
      providerId: "caldav",
      startIso: "2026-06-14T18:00:00.000Z"
    });
    const google = firedKey({
      id: "shared",
      kind: "calendar",
      providerEventId: "raw",
      providerId: "google",
      startIso: "2026-06-14T18:00:00.000Z"
    });
    expect(caldav).toBe(JSON.stringify(["calendar", "caldav", "raw", "2026-06-14T18:00:00.000Z"]));
    expect(google).not.toBe(caldav);
    expect(firedKey({
      id: "shared",
      kind: "calendar",
      providerId: "local",
      startIso: "2026-06-14T18:00:00.000Z"
    })).toBe(JSON.stringify(["calendar", "local", "shared", "2026-06-14T18:00:00.000Z"]));
    expect(firedKey({ id: "shared", kind: "calendar", startIso: "2026-06-14T18:00:00.000Z" }))
      .toBe(legacyCalendarWildcardKey({ id: "shared", startIso: "2026-06-14T18:00:00.000Z" }));
  });

  it("keeps exact calendar keys distinct across generated provider/id/start combinations", () => {
    const keys = new Set<string>();
    for (let provider = 0; provider < 8; provider += 1) {
      for (let occurrence = 0; occurrence < 20; occurrence += 1) {
        keys.add(firedKey({
          id: `shared-${(occurrence % 3).toString()}`,
          kind: "calendar",
          providerEventId: `raw-${occurrence.toString()}`,
          providerId: `provider-${provider.toString()}`,
          startIso: new Date(Date.UTC(2026, 0, 1, 0, occurrence)).toISOString()
        }));
      }
    }
    expect(keys.size).toBe(160);
  });
});
