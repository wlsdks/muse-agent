import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  appendInterruptionDelivery,
  appendSurfaced,
  avoidedSourceKeys,
  readDigestQueue,
  readInterruptionLedger,
  readLastProactiveDeliveries,
  readTrustLedger,
  recordOutcome
} from "@muse/stores";

import { applyInterruptionBudget, resolveInterruptionBudgetCaps } from "../src/interruption-gate.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-interruption-gate-"));
}

const NOW = new Date("2026-07-11T12:00:00.000Z");

describe("applyInterruptionBudget", () => {
  it("delivers and records the ledger when within budget", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    let delivers = 0;
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      text: "your Tuesday journal habit — want the template open?"
    });
    expect(result.outcome).toBe("delivered");
    expect(delivers).toBe(1);
    const ledger = await readInterruptionLedger(ledgerFile);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ source: "pattern-firing" });
    expect((await readDigestQueue(digestFile))).toHaveLength(0);
  });

  it("digests instead of delivering once the hourly cap is spent — deliver is never called", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    // Pre-fill the ledger at the hourly cap (2).
    await appendInterruptionDelivery(ledgerFile, { at: new Date(NOW.getTime() - 5_000), source: "ambient-notice" });
    await appendInterruptionDelivery(ledgerFile, { at: new Date(NOW.getTime() - 3_000), source: "ambient-notice" });

    let delivers = 0;
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "ambient-notice",
      sourceId: "standup-notes",
      text: "  Standup at 14:00 —  open your notes.  "
    });
    expect(result.outcome).toBe("digested");
    expect(delivers).toBe(0);
    const queued = await readDigestQueue(digestFile);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      source: "ambient-notice",
      sourceId: "standup-notes",
      // digest-queue.ts collapses whitespace and trims on append.
      text: "Standup at 14:00 — open your notes."
    });
    // No new ledger entry for a suppressed notice.
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(2);
  });

  it("cap <= 0 is unlimited — always delivers", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    for (let i = 0; i < 10; i += 1) {
      await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "pattern-firing" });
    }
    let delivers = 0;
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 0, hourlyCap: 0 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      text: "eleventh notice, still unlimited"
    });
    expect(result.outcome).toBe("delivered");
    expect(delivers).toBe(1);
  });

  it("fail-open: a corrupt ledger file never blocks delivery (the caps that would otherwise reject it)", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    await writeFile(ledgerFile, "{ not valid json", "utf8");

    let delivers = 0;
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 1, hourlyCap: 1 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "followup",
      text: "corrupt ledger still delivers"
    });
    expect(result.outcome).toBe("delivered");
    expect(delivers).toBe(1);
  });

  it("delivery stays reported when the ledger APPEND fails after a successful send", async () => {
    const dir = tmpDir();
    // A ledger path whose PARENT is a regular file (not a directory) makes the
    // atomic writer's `mkdir(dirname(file), { recursive: true })` fail with
    // ENOTDIR — deliver() has already succeeded by then.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const ledgerFile = join(blocker, "ledger.json");
    const digestFile = join(dir, "digest.json");
    let delivers = 0;
    const logs: string[] = [];
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      errorLogger: (message) => logs.push(message),
      ledgerFile,
      now: NOW,
      source: "background-exit",
      text: "delivered despite a broken ledger dir"
    });
    expect(result.outcome).toBe("delivered");
    expect(delivers).toBe(1);
    expect(logs.some((line) => line.includes("ledger append failed"))).toBe(true);
  });

  it("a deliver() throw propagates uncaught (a real send failure is the caller's concern, not the gate's)", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    await expect(
      applyInterruptionBudget({
        caps: { dailyCap: 6, hourlyCap: 2 },
        deliver: async () => {
          throw new Error("messaging provider down");
        },
        digestFile,
        ledgerFile,
        now: NOW,
        source: "commitment-checkin",
        text: "will not be recorded"
      })
    ).rejects.toThrow("messaging provider down");
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(0);
  });

  it("digest-append failure over budget logs loudly and drops the item (accepted lossy edge) — never throws, never falls back to delivery", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "pattern-firing" });
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "pattern-firing" });
    // A digest path whose PARENT is a regular file (not a directory) makes the
    // atomic writer's mkdir fail with ENOTDIR.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const digestFile = join(blocker, "digest.json");
    const lastDeliveryFile = join(dir, "last-delivery.json");
    let delivers = 0;
    const logs: string[] = [];
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      errorLogger: (message) => logs.push(message),
      lastDeliveryFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      text: "lost notice"
    });
    expect(result.outcome).toBe("digested");
    expect(delivers).toBe(0);
    expect(logs.some((line) => line.includes("digest append failed"))).toBe(true);
    expect(await readLastProactiveDeliveries(lastDeliveryFile)).toEqual([]);
  });
  it("a vetoed source (avoidedSources) skips entirely — no send, no digest, no ledger entry, {outcome: \"skipped\"}", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    let delivers = 0;
    const result = await applyInterruptionBudget({
      avoidedSources: new Set(["pattern-firing:tod:mon:9-12:journal"]),
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      sourceId: "tod:mon:9-12:journal",
      sourceKey: "pattern-firing:tod:mon:9-12:journal",
      text: "your Tuesday journal habit — want the template open?"
    });
    expect(result.outcome).toBe("skipped");
    expect(delivers).toBe(0);
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(0);
    expect(await readDigestQueue(digestFile)).toHaveLength(0);
  });

  it("a KIND-level veto (no ':id') also skips — the followup/background-exit veto shape", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    let delivers = 0;
    const result = await applyInterruptionBudget({
      avoidedSources: new Set(["followup"]),
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "followup",
      sourceId: "fu-1",
      sourceKey: "followup:fu-1",
      text: "kind-level vetoed"
    });
    expect(result.outcome).toBe("skipped");
    expect(delivers).toBe(0);
  });

  it("avoidedSources checks the resolved sourceKey, not a bare sourceId or source-only match", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    let delivers = 0;
    // The vetoed set has the OTHER pattern's key — this one must still deliver.
    const result = await applyInterruptionBudget({
      avoidedSources: new Set(["pattern-firing:some-other-pattern"]),
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      sourceId: "tod:mon:9-12:journal",
      sourceKey: "pattern-firing:tod:mon:9-12:journal",
      text: "not the vetoed pattern"
    });
    expect(result.outcome).toBe("delivered");
    expect(delivers).toBe(1);
  });

  it("un-veto (muse proactive keep) is a real reversal — a later `avoidedSourceKeys` re-read lets the source deliver again", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    const trustLedgerFile = join(dir, "trust.json");
    const key = "pattern-firing:tod:mon:9-12:journal";

    // Simulate the channel-veto reply: a surfaced notice, then vetoed.
    await appendSurfaced(trustLedgerFile, { id: "tod:mon:9-12:journal", kind: "pattern-firing", surfacedAtMs: NOW.getTime() - 60_000, title: "journal habit" });
    await recordOutcome(trustLedgerFile, key, "vetoed", NOW.getTime() - 30_000);

    const avoidedAfterVeto = avoidedSourceKeys(await readTrustLedger(trustLedgerFile));
    expect(avoidedAfterVeto.has(key)).toBe(true);
    const skipped = await applyInterruptionBudget({
      avoidedSources: avoidedAfterVeto,
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        throw new Error("must not be called while vetoed");
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      sourceId: "tod:mon:9-12:journal",
      sourceKey: key,
      text: "your Tuesday journal habit"
    });
    expect(skipped.outcome).toBe("skipped");

    // `muse proactive keep <key>` — recordOutcome's append path (no unrated
    // entry to update since the surfaced entry is already rated "vetoed").
    await recordOutcome(trustLedgerFile, key, "kept", NOW.getTime());

    const avoidedAfterKeep = avoidedSourceKeys(await readTrustLedger(trustLedgerFile));
    expect(avoidedAfterKeep.has(key)).toBe(false);

    let delivers = 0;
    const delivered = await applyInterruptionBudget({
      avoidedSources: avoidedAfterKeep,
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      sourceId: "tod:mon:9-12:journal",
      sourceKey: key,
      text: "your Tuesday journal habit"
    });
    expect(delivered.outcome).toBe("delivered");
    expect(delivers).toBe(1);
  });

  it("last-delivery sidecar records a `delivered` outcome with sourceKey + title", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => undefined,
      digestFile,
      lastDeliveryFile,
      ledgerFile,
      now: NOW,
      source: "followup",
      sourceId: "fu-1",
      sourceKey: "followup:fu-1",
      text: "checking in on the interview",
      title: "prep for the interview"
    });
    expect(result.outcome).toBe("delivered");
    const entries = await readLastProactiveDeliveries(lastDeliveryFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      at: NOW.toISOString(),
      outcome: "delivered",
      sourceKey: "followup:fu-1",
      title: "prep for the interview"
    });
  });

  it("last-delivery sidecar records a `digested` outcome (over-budget suppression) too", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    const lastDeliveryFile = join(dir, "last-delivery.json");
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "ambient-notice" });
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "ambient-notice" });
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => undefined,
      digestFile,
      lastDeliveryFile,
      ledgerFile,
      now: NOW,
      source: "ambient-notice",
      sourceId: "standup-notes",
      sourceKey: "ambient-notice:standup-notes",
      text: "over budget",
      title: "standup rule"
    });
    expect(result.outcome).toBe("digested");
    const entries = await readLastProactiveDeliveries(lastDeliveryFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "digested", sourceKey: "ambient-notice:standup-notes" });
  });

  it("a skipped (vetoed) outcome does NOT append to the last-delivery sidecar (nothing new reached the user)", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const result = await applyInterruptionBudget({
      avoidedSources: new Set(["pattern-firing:x"]),
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => undefined,
      digestFile,
      lastDeliveryFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      sourceKey: "pattern-firing:x",
      text: "vetoed"
    });
    expect(result.outcome).toBe("skipped");
    expect(await readLastProactiveDeliveries(lastDeliveryFile)).toHaveLength(0);
  });

  it("last-delivery append failure is fail-open (logged, delivery still reported)", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const lastDeliveryFile = join(blocker, "last-delivery.json");
    let delivers = 0;
    const logs: string[] = [];
    const result = await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => {
        delivers += 1;
      },
      digestFile,
      errorLogger: (message) => logs.push(message),
      lastDeliveryFile,
      ledgerFile,
      now: NOW,
      source: "commitment-checkin",
      text: "delivered despite a broken last-delivery path"
    });
    expect(result.outcome).toBe("delivered");
    expect(delivers).toBe(1);
    expect(logs.some((line) => line.includes("last-delivery append failed"))).toBe(true);
  });

  it("absent avoidedSources/lastDeliveryFile/sourceKey/title → the ledger and digest files stay byte-identical to pre-veto behavior", async () => {
    const dir = tmpDir();
    const ledgerFile = join(dir, "ledger.json");
    const digestFile = join(dir, "digest.json");
    await applyInterruptionBudget({
      caps: { dailyCap: 6, hourlyCap: 2 },
      deliver: async () => undefined,
      digestFile,
      ledgerFile,
      now: NOW,
      source: "pattern-firing",
      text: "no new options set"
    });
    const ledgerRaw = await readFile(ledgerFile, "utf8");
    expect(ledgerRaw).toBe(`${JSON.stringify({ deliveries: [{ at: NOW.toISOString(), source: "pattern-firing" }] }, null, 2)}\n`);
    expect(await readDigestQueue(digestFile)).toHaveLength(0);
  });
});

describe("resolveInterruptionBudgetCaps", () => {
  it("defaults an unset hourlyCap/dailyCap to 0 (unlimited, per withinInterruptionBudget's convention)", () => {
    expect(resolveInterruptionBudgetCaps({ digestFile: "d", ledgerFile: "l" })).toEqual({ dailyCap: 0, hourlyCap: 0 });
    expect(resolveInterruptionBudgetCaps({ dailyCap: 6, digestFile: "d", hourlyCap: 2, ledgerFile: "l" })).toEqual({ dailyCap: 6, hourlyCap: 2 });
  });
});
