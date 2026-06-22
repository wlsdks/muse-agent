import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSurfaced,
  isSourceAvoided,
  readTrustLedger,
  recordOutcome,
  sourceKey,
  type TrustLedgerEntry
} from "../src/proactive-trust-ledger.js";

const MAX = 2_000;
let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), `muse-trust-trim-${randomUUID()}-`)); file = join(dir, "ledger.json"); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

const surfaced = (id: string, surfacedAtMs: number, outcome?: TrustLedgerEntry["outcome"]): TrustLedgerEntry => ({
  kind: "calendar",
  sourceKey: sourceKey("calendar", id),
  surfacedAtMs,
  title: `t-${id}`,
  ...(outcome ? { outcome, outcomeAtMs: surfacedAtMs } : {})
});

// writeTrustLedger FIFO-trims to MAX_LEDGER_ENTRIES. A naive slice() of the most
// recent N drops the OLDEST entries first — including a vetoed source (learned
// avoidance). After enough newer surfaces the veto is evicted and the vetoed
// source resurfaces. Vetoed entries must survive the trim. writeTrustLedger is
// private, so we drive the trim through the public append/record path.
describe("trust-ledger trim preserves vetoed sources (learned avoidance)", () => {
  it("keeps an old veto even when far more than MAX newer surfaces accrue", async () => {
    // Seed: one old veto (oldest entry) + a full cap of plain surfaces, written
    // straight to disk in the on-disk shape readTrustLedger expects.
    const seed: TrustLedgerEntry[] = [
      surfaced("vetoed-src", 1, "vetoed"),
      ...Array.from({ length: MAX }, (_u, i) => surfaced(`s${i.toString()}`, 1_000 + i))
    ];
    await writeFile(file, `${JSON.stringify({ surfaced: seed }, null, 2)}\n`, "utf8");

    // One more append tips the ledger over the cap and triggers the trim.
    await appendSurfaced(file, { id: "newest", kind: "calendar", surfacedAtMs: 9_000_000, title: "newest" });

    const ledger = await readTrustLedger(file);
    expect(isSourceAvoided(ledger, "calendar", "vetoed-src")).toBe(true);
    // Non-vetoed entries are still FIFO-trimmed to the cap.
    const nonVetoed = ledger.filter((e) => e.outcome !== "vetoed");
    expect(nonVetoed.length).toBe(MAX);
  });

  it("a veto recorded via recordOutcome survives a later over-cap trim", async () => {
    // Surface then veto one source, then pad to over the cap via recordOutcome's
    // trim path (a pre-emptive veto append also writes through writeTrustLedger).
    const seed: TrustLedgerEntry[] = [
      surfaced("keepme", 1),
      ...Array.from({ length: MAX }, (_u, i) => surfaced(`s${i.toString()}`, 1_000 + i))
    ];
    await writeFile(file, `${JSON.stringify({ surfaced: seed }, null, 2)}\n`, "utf8");

    await recordOutcome(file, sourceKey("calendar", "keepme"), "vetoed", 5_000);
    // Push further over the cap so the trim runs again.
    await appendSurfaced(file, { id: "after", kind: "calendar", surfacedAtMs: 9_000_001, title: "after" });

    const ledger = await readTrustLedger(file);
    expect(isSourceAvoided(ledger, "calendar", "keepme")).toBe(true);
  });
});
