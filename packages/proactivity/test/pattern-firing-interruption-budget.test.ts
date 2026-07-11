import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { appendInterruptionDelivery, readDigestQueue, readInterruptionLedger, readLastProactiveDeliveries, readPatternsFired, recordOutcome } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDuePatternNotices } from "../src/pattern-firing-loop.js";

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

let dir: string;
let notesDir: string;
let patternsFiredFile: string;
let ledgerFile: string;
let digestFile: string;
const NOW = new Date(2026, 4, 12, 21, 30, 0); // Tuesday 21:30 — the fire slot

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-pattern-budget-"));
  notesDir = join(dir, "notes");
  patternsFiredFile = join(dir, "patterns-fired.json");
  ledgerFile = join(dir, "ledger.json");
  digestFile = join(dir, "digest.json");
  await mkdir(join(notesDir, "journal"), { recursive: true });
  for (let k = 1; k <= 5; k += 1) {
    const file = join(notesDir, "journal", `entry-${k.toString()}.md`);
    await writeFile(file, `journal ${k.toString()}`, "utf8");
    const when = new Date(NOW.getTime() - k * 7 * 86_400_000);
    await utimes(file, when, when);
  }
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runDuePatternNotices — interruption budget (opt-in)", () => {
  it("cap reached: registry.send is never called, the suggestion lands in the digest, and the cooldown sidecar still advances", async () => {
    const sent: OutboundMessage[] = [];
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "pattern-firing" });

    const summary = await runDuePatternNotices({
      destination: "555",
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 1, ledgerFile },
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(0);
    expect(sent).toEqual([]);
    const queued = await readDigestQueue(digestFile);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.source).toBe("pattern-firing");
    // The cooldown sidecar still advances — a suppressed match doesn't re-offer next tick.
    const fired = await readPatternsFired(patternsFiredFile);
    expect(fired.length).toBeGreaterThan(0);
  });

  it("cap not reached: delivers exactly as without a budget, and records the ledger", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      destination: "555",
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, ledgerFile },
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(1);
    expect(await readDigestQueue(digestFile)).toHaveLength(0);
  });

  it("interruptionBudget absent: behavior is byte-identical to the pre-budget path", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("cap reached: no registry.send, but the broker still publishes (ambient stream is not budget-gated)", async () => {
    const sent: OutboundMessage[] = [];
    const published: Array<{ userId: string; notice: { kind: string; text: string; sourceId?: string } }> = [];
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "pattern-firing" });

    const summary = await runDuePatternNotices({
      agentInitiatedNoticeBroker: {
        publish: (userId, notice) => {
          published.push({ notice, userId });
        }
      },
      agentInitiatedNoticeUserId: "u1",
      destination: "555",
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 1, ledgerFile },
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(0);
    expect(sent).toEqual([]);
    expect(await readDigestQueue(digestFile)).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]!.userId).toBe("u1");
    expect(published[0]!.notice.kind).toBe("pattern");
  });

  it("a channel-vetoed pattern also silences the broker (veto is stronger than a budget digest)", async () => {
    const discoverySent: OutboundMessage[] = [];
    const discovery = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile: join(dir, "discovery2-patterns-fired.json"),
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(discoverySent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    const patternId = discovery.fired[0]!.id;

    const trustLedgerFile = join(dir, "trust2.json");
    await recordOutcome(trustLedgerFile, `pattern-firing:${patternId}`, "vetoed", NOW.getTime());

    const sent: OutboundMessage[] = [];
    const published: Array<{ userId: string; notice: { kind: string; text: string; sourceId?: string } }> = [];
    const summary = await runDuePatternNotices({
      agentInitiatedNoticeBroker: {
        publish: (userId, notice) => {
          published.push({ notice, userId });
        }
      },
      agentInitiatedNoticeUserId: "u1",
      destination: "555",
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, ledgerFile, trustLedgerFile },
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(sent).toEqual([]);
    expect(summary.delivered).toBe(0);
    expect(published).toEqual([]); // the broker did NOT publish — veto silences it too
  });

  it("a corrupt ledger file fails OPEN — the suggestion still sends", async () => {
    const sent: OutboundMessage[] = [];
    await writeFile(ledgerFile, "{ not valid json", "utf8");
    const summary = await runDuePatternNotices({
      destination: "555",
      interruptionBudget: { dailyCap: 1, digestFile, hourlyCap: 1, ledgerFile },
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("a channel-vetoed pattern (trust ledger) is fully silent: no send, no digest, cooldown still advances", async () => {
    // Discover this pattern's deterministic id via a throwaway run (separate
    // sidecars — its cooldown state must not leak into the tested run below).
    const discoverySent: OutboundMessage[] = [];
    const discovery = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile: join(dir, "discovery-patterns-fired.json"),
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(discoverySent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(discovery.fired).toHaveLength(1);
    const patternId = discovery.fired[0]!.id;

    const trustLedgerFile = join(dir, "trust.json");
    await recordOutcome(trustLedgerFile, `pattern-firing:${patternId}`, "vetoed", NOW.getTime());

    const sent: OutboundMessage[] = [];
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const summary = await runDuePatternNotices({
      destination: "555",
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, lastDeliveryFile, ledgerFile, trustLedgerFile },
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(sent).toEqual([]);
    expect(summary.delivered).toBe(0);
    expect(await readDigestQueue(digestFile)).toHaveLength(0);
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(0);
    expect(await readLastProactiveDeliveries(lastDeliveryFile)).toHaveLength(0);
    // The cooldown sidecar still advances — a vetoed match doesn't re-offer next tick either.
    expect((await readPatternsFired(patternsFiredFile)).length).toBeGreaterThan(0);
  });

  it("wired lastDeliveryFile records the pattern's sourceKey + delivered outcome", async () => {
    const sent: OutboundMessage[] = [];
    const lastDeliveryFile = join(dir, "last-delivery.json");
    const summary = await runDuePatternNotices({
      destination: "555",
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, lastDeliveryFile, ledgerFile },
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    const patternId = summary.fired[0]!.id;
    const entries = await readLastProactiveDeliveries(lastDeliveryFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "delivered", sourceKey: `pattern-firing:${patternId}` });
  });
});
