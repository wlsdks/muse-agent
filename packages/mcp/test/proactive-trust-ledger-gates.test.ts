import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSurfaced,
  avoidedSourceKeys,
  isSourceAvoided,
  readTrustLedger,
  sourceKey,
  withinDailyCap,
  type TrustLedgerEntry
} from "../src/proactive-trust-ledger.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = 1_000_000_000_000;
const entry = (id: string, surfacedAtMs: number, outcome?: TrustLedgerEntry["outcome"]): TrustLedgerEntry => ({
  kind: "calendar",
  sourceKey: sourceKey("calendar", id),
  surfacedAtMs,
  title: `t-${id}`,
  ...(outcome ? { outcome } : {})
});

// The two gates the proactive daemon consults before surfacing a notice
// (NORTH STAR: gated proactivity). Pure functions over the ledger.
describe("withinDailyCap — proactive surface budget", () => {
  const recent = [entry("a", NOW - 1_000), entry("b", NOW - 2_000), entry("old", NOW - DAY_MS - 1)];

  it("returns true while strictly under the cap and false once at/over it (2 recent in window)", () => {
    expect(withinDailyCap(recent, NOW, 3, DAY_MS)).toBe(true); // 2 < 3
    expect(withinDailyCap(recent, NOW, 2, DAY_MS)).toBe(false); // 2 < 2 is false → blocked at the cap
  });

  it("fail-closed on a non-positive / non-finite cap (no proactivity)", () => {
    expect(withinDailyCap(recent, NOW, 0, DAY_MS)).toBe(false);
    expect(withinDailyCap(recent, NOW, -1, DAY_MS)).toBe(false);
    expect(withinDailyCap(recent, NOW, Number.NaN, DAY_MS)).toBe(false);
  });

  it("counts the window as (now-window, now]: an entry exactly at the window start is excluded, one at now is included", () => {
    const bnd = [entry("atSince", NOW - DAY_MS), entry("atNow", NOW)];
    expect(withinDailyCap(bnd, NOW, 2, DAY_MS)).toBe(true); // only atNow counts → 1 < 2
    expect(withinDailyCap(bnd, NOW, 1, DAY_MS)).toBe(false); // 1 < 1 is false
  });
});

describe("avoidedSourceKeys / isSourceAvoided — learned avoidance", () => {
  const entries = [entry("v1", NOW, "vetoed"), entry("k1", NOW, "kept"), entry("a1", NOW, "acted"), entry("u1", NOW)];

  it("collects ONLY vetoed sources (kept / acted / unrated are not avoided)", () => {
    expect([...avoidedSourceKeys(entries)]).toEqual(["calendar:v1"]);
  });

  it("isSourceAvoided is true for a vetoed source and false otherwise", () => {
    expect(isSourceAvoided(entries, "calendar", "v1")).toBe(true);
    expect(isSourceAvoided(entries, "calendar", "k1")).toBe(false);
    expect(isSourceAvoided(entries, "calendar", "never-seen")).toBe(false);
  });
});

describe("appendSurfaced", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-trust-")); file = join(dir, "ledger.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("appends an entry with the derived sourceKey", async () => {
    await appendSurfaced(file, { id: "m1", kind: "email", surfacedAtMs: NOW, title: "inbox" });
    const ledger = await readTrustLedger(file);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "email", sourceKey: "email:m1", title: "inbox" });
  });
});
