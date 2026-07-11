import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendInterruptionDelivery, readDigestQueue, readInterruptionLedger, readLastProactiveDeliveries, recordOutcome } from "@muse/stores";

import { createAmbientNoticeRunner, type AmbientNoticeRule, type AmbientSignal, type ProactiveNoticeSink } from "../src/ambient-notice-loop.js";

const standup: AmbientNoticeRule = {
  id: "standup",
  match: { window: "standup" },
  message: "Standup at 14:00 — open your notes.",
  title: "Standup"
};

function tmpBudgetDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-ambient-budget-"));
}

const NOW = new Date("2026-07-11T12:00:00.000Z");

describe("createAmbientNoticeRunner — interruption budget (opt-in)", () => {
  it("cap reached: sink.deliver is never called, the notice lands in the digest, and the edge is still consumed (no per-tick spam)", async () => {
    const budgetDir = tmpBudgetDir();
    const ledgerFile = join(budgetDir, "ledger.json");
    const digestFile = join(budgetDir, "digest.json");
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "ambient-notice" });

    const delivered: unknown[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    let signal: AmbientSignal | undefined = { window: "Team Standup — 14:00" };
    const runner = createAmbientNoticeRunner({
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 1, ledgerFile },
      now: () => NOW,
      rules: [standup],
      sink,
      source: { snapshot: () => signal }
    });

    const first = await runner.tick();
    expect(first.delivered).toBe(0);
    expect(delivered).toHaveLength(0);
    const queued = await readDigestQueue(digestFile);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ source: "ambient-notice", sourceId: "standup" });

    // The edge was consumed by the digest suppression — a still-matching
    // signal must NOT re-queue the same notice every tick.
    const second = await runner.tick();
    expect(second.delivered).toBe(0);
    expect((await readDigestQueue(digestFile))).toHaveLength(1); // not re-queued

    // Clear then re-match → re-arms and fires (still gated) again.
    signal = undefined;
    await runner.tick();
    signal = { window: "Team Standup — 14:00" };
    const third = await runner.tick();
    expect(third.delivered).toBe(0);
    expect((await readDigestQueue(digestFile))).toHaveLength(2);
  });

  it("cap not reached: delivers exactly as without a budget, and records the ledger", async () => {
    const budgetDir = tmpBudgetDir();
    const ledgerFile = join(budgetDir, "ledger.json");
    const digestFile = join(budgetDir, "digest.json");

    const delivered: unknown[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    const runner = createAmbientNoticeRunner({
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, ledgerFile },
      now: () => NOW,
      rules: [standup],
      sink,
      source: { snapshot: () => ({ window: "Team Standup — 14:00" }) }
    });

    const summary = await runner.tick();
    expect(summary.delivered).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(1);
    expect(await readDigestQueue(digestFile)).toHaveLength(0);
  });

  it("interruptionBudget absent: behavior is byte-identical to the pre-budget path", async () => {
    const delivered: unknown[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    const runner = createAmbientNoticeRunner({
      rules: [standup],
      sink,
      source: { snapshot: () => ({ window: "Team Standup — 14:00" }) }
    });
    const summary = await runner.tick();
    expect(summary.delivered).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it("a corrupt ledger file fails OPEN — the notice still delivers", async () => {
    const budgetDir = tmpBudgetDir();
    const ledgerFile = join(budgetDir, "ledger.json");
    const digestFile = join(budgetDir, "digest.json");
    writeFileSync(ledgerFile, "{ not valid json", "utf8");

    const delivered: unknown[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    const runner = createAmbientNoticeRunner({
      interruptionBudget: { dailyCap: 1, digestFile, hourlyCap: 1, ledgerFile },
      now: () => NOW,
      rules: [standup],
      sink,
      source: { snapshot: () => ({ window: "Team Standup — 14:00" }) }
    });
    const summary = await runner.tick();
    expect(summary.delivered).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it("a channel-vetoed rule (trust ledger) is fully silent: sink never called, no digest, edge still consumed", async () => {
    const budgetDir = tmpBudgetDir();
    const ledgerFile = join(budgetDir, "ledger.json");
    const digestFile = join(budgetDir, "digest.json");
    const trustLedgerFile = join(budgetDir, "trust.json");
    await recordOutcome(trustLedgerFile, "ambient-notice:standup", "vetoed", NOW.getTime());

    const delivered: unknown[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    const lastDeliveryFile = join(budgetDir, "last-delivery.json");
    const runner = createAmbientNoticeRunner({
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, lastDeliveryFile, ledgerFile, trustLedgerFile },
      now: () => NOW,
      rules: [standup],
      sink,
      source: { snapshot: () => ({ window: "Team Standup — 14:00" }) }
    });

    const summary = await runner.tick();
    expect(delivered).toHaveLength(0);
    expect(summary.delivered).toBe(0);
    expect(await readDigestQueue(digestFile)).toHaveLength(0);
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(0);
    expect(await readLastProactiveDeliveries(lastDeliveryFile)).toHaveLength(0);
    // Edge still consumed — a vetoed rule doesn't re-fire (and re-attempt the
    // veto check) every tick while the signal keeps matching.
    expect(summary.firedRuleIds).toContain("standup");
  });

  it("wired lastDeliveryFile records the rule's sourceKey + rule title", async () => {
    const budgetDir = tmpBudgetDir();
    const ledgerFile = join(budgetDir, "ledger.json");
    const digestFile = join(budgetDir, "digest.json");
    const lastDeliveryFile = join(budgetDir, "last-delivery.json");
    const delivered: unknown[] = [];
    const sink: ProactiveNoticeSink = { deliver: (notice) => { delivered.push(notice); } };
    const runner = createAmbientNoticeRunner({
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, lastDeliveryFile, ledgerFile },
      now: () => NOW,
      rules: [standup],
      sink,
      source: { snapshot: () => ({ window: "Team Standup — 14:00" }) }
    });
    const summary = await runner.tick();
    expect(summary.delivered).toBe(1);
    const entries = await readLastProactiveDeliveries(lastDeliveryFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "delivered", sourceKey: "ambient-notice:standup", title: "Standup" });
  });
});
