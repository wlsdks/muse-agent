import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendInterruptionDelivery,
  readInterruptionLedger,
  withinInterruptionBudget,
  type InterruptionDeliveryEntry
} from "../src/interruption-budget.js";

const HOUR_MS = 60 * 60 * 1_000;
const NOW = new Date("2026-07-11T12:00:00.000Z");

const entry = (source: string, atMs: number): InterruptionDeliveryEntry => ({ at: new Date(atMs).toISOString(), source });

describe("withinInterruptionBudget — sliding-window gate", () => {
  it("counts the hourly window as (now-60min, now]: 59min-ago counts, 61min-ago does not", () => {
    const at59 = [entry("a", NOW.getTime() - 59 * 60 * 1_000)];
    const at61 = [entry("a", NOW.getTime() - 61 * 60 * 1_000)];
    expect(withinInterruptionBudget(at59, NOW, { dailyCap: 6, hourlyCap: 1 })).toBe(false); // 1 recent, cap 1 -> blocked
    expect(withinInterruptionBudget(at61, NOW, { dailyCap: 6, hourlyCap: 1 })).toBe(true); // outside 60min window -> 0 recent
  });

  it("counts the daily window as (now-24h, now]: 23h-ago counts, 25h-ago does not", () => {
    const at23h = [entry("a", NOW.getTime() - 23 * HOUR_MS)];
    const at25h = [entry("a", NOW.getTime() - 25 * HOUR_MS)];
    expect(withinInterruptionBudget(at23h, NOW, { dailyCap: 1, hourlyCap: 100 })).toBe(false);
    expect(withinInterruptionBudget(at25h, NOW, { dailyCap: 1, hourlyCap: 100 })).toBe(true);
  });

  it("an entry exactly at now counts; an entry exactly at the window start does not", () => {
    const boundary = [entry("atSince", NOW.getTime() - HOUR_MS), entry("atNow", NOW.getTime())];
    expect(withinInterruptionBudget(boundary, NOW, { dailyCap: 100, hourlyCap: 2 })).toBe(true); // only atNow counts -> 1 < 2
    expect(withinInterruptionBudget(boundary, NOW, { dailyCap: 100, hourlyCap: 1 })).toBe(false); // 1 < 1 is false
  });

  it("returns true while strictly under both caps, false once either is reached", () => {
    const entries = [entry("a", NOW.getTime() - 1_000), entry("b", NOW.getTime() - 2_000)];
    expect(withinInterruptionBudget(entries, NOW, { dailyCap: 6, hourlyCap: 3 })).toBe(true); // 2 < 3 and 2 < 6
    expect(withinInterruptionBudget(entries, NOW, { dailyCap: 6, hourlyCap: 2 })).toBe(false); // 2 < 2 is false
    expect(withinInterruptionBudget(entries, NOW, { dailyCap: 2, hourlyCap: 3 })).toBe(false); // daily 2 < 2 is false
  });

  it("cap <= 0 (or non-finite) means that window is UNLIMITED, not blocked", () => {
    const many = Array.from({ length: 50 }, (_u, i) => entry(`s${i.toString()}`, NOW.getTime() - i * 1_000));
    expect(withinInterruptionBudget(many, NOW, { dailyCap: 6, hourlyCap: 0 })).toBe(false); // daily still caps
    expect(withinInterruptionBudget(many, NOW, { dailyCap: 0, hourlyCap: 0 })).toBe(true); // both off -> unlimited
    expect(withinInterruptionBudget(many, NOW, { dailyCap: -1, hourlyCap: -5 })).toBe(true);
    expect(withinInterruptionBudget(many, NOW, { dailyCap: Number.NaN, hourlyCap: Number.NaN })).toBe(true);
  });
});

describe("readInterruptionLedger — tolerant reads", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-interruption-${randomUUID()}-`)); file = join(dir, "ledger.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("missing file -> empty array", async () => {
    expect(await readInterruptionLedger(file)).toEqual([]);
  });

  it("malformed JSON -> empty array (does not throw)", async () => {
    await writeFile(file, "{ not json", "utf8");
    expect(await readInterruptionLedger(file)).toEqual([]);
  });

  it("wrong shape (missing deliveries array) -> empty array", async () => {
    await writeFile(file, JSON.stringify({ notDeliveries: [] }), "utf8");
    expect(await readInterruptionLedger(file)).toEqual([]);
  });

  it("one corrupt row does not sink the whole file — valid rows survive", async () => {
    await writeFile(
      file,
      JSON.stringify({ deliveries: [{ at: "2026-07-11T00:00:00.000Z", source: "pattern-firing" }, { source: "missing-at" }, "not-an-object"] }),
      "utf8"
    );
    const ledger = await readInterruptionLedger(file);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ source: "pattern-firing" });
  });
});

describe("appendInterruptionDelivery", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-interruption-${randomUUID()}-`)); file = join(dir, "ledger.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("appends an entry with the given source and ISO timestamp", async () => {
    await appendInterruptionDelivery(file, { at: NOW, source: "ambient-notice" });
    const ledger = await readInterruptionLedger(file);
    expect(ledger).toEqual([{ at: NOW.toISOString(), source: "ambient-notice" }]);
  });

  it("prunes entries older than 48h relative to the appended entry's time", async () => {
    await writeFile(
      file,
      JSON.stringify({
        deliveries: [
          entry("old", NOW.getTime() - 49 * HOUR_MS), // pruned
          entry("recent", NOW.getTime() - 47 * HOUR_MS) // kept
        ]
      }),
      "utf8"
    );
    await appendInterruptionDelivery(file, { at: NOW, source: "new" });
    const ledger = await readInterruptionLedger(file);
    expect(ledger.map((e) => e.source).sort()).toEqual(["new", "recent"]);
  });

  it("serializes concurrent appends — no lost record, no rename crash", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_u, i) => appendInterruptionDelivery(file, { at: new Date(NOW.getTime() + i), source: `s${i.toString()}` }))
    );
    const ledger = await readInterruptionLedger(file);
    expect(ledger).toHaveLength(25);
    expect(new Set(ledger.map((e) => e.source)).size).toBe(25);
  }, 30_000);
});
