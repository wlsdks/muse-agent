import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { appendInterruptionDelivery, readDigestQueue, readInterruptionLedger, registerBackgroundProcess, updateBackgroundProcess, type BackgroundProcessRecord } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backgroundExitNoticeText,
  readBackgroundExitNotified,
  runDueBackgroundExitNotices,
  type AgentInitiatedNoticeBrokerLike,
  type RunDueBackgroundExitNoticesOptions
} from "../src/index.js";

let dir: string;
let storeFile: string;
let notifiedFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bg-exit-notice-"));
  storeFile = join(dir, "background-processes.json");
  notifiedFile = join(dir, "bg-exit-notified.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

interface Captured { readonly userId: string; readonly kind: string; readonly text: string; readonly sourceId?: string }

function fakeBroker(): { broker: AgentInitiatedNoticeBrokerLike; sent: Captured[] } {
  const sent: Captured[] = [];
  const broker: AgentInitiatedNoticeBrokerLike = {
    publish(userId, notice) { sent.push({ kind: notice.kind, sourceId: notice.sourceId, text: notice.text, userId }); }
  };
  return { broker, sent };
}

const base = (over: Partial<BackgroundProcessRecord>): BackgroundProcessRecord => ({
  command: "pnpm build",
  id: "p1",
  pid: 4242,
  startedAt: "2026-07-01T10:00:00.000Z",
  status: "running",
  ...over
});

async function seedExited(record: Partial<BackgroundProcessRecord>): Promise<void> {
  const full = base(record);
  await registerBackgroundProcess(storeFile, { ...full, status: "running" });
  await updateBackgroundProcess(storeFile, full.id, {
    status: full.status,
    exitCode: full.exitCode,
    endedAt: "2026-07-01T10:05:00.000Z"
  });
}

function opts(over: Partial<RunDueBackgroundExitNoticesOptions>): RunDueBackgroundExitNoticesOptions {
  return { notifiedFile, storeFile, ...over } as RunDueBackgroundExitNoticesOptions;
}

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

describe("backgroundExitNoticeText", () => {
  it("phrases a clean exit and a failure with exit code", () => {
    expect(backgroundExitNoticeText(base({ status: "exited", exitCode: 0 }))).toContain("finished");
    expect(backgroundExitNoticeText(base({ status: "exited", exitCode: 0 }))).toContain("exit code 0");
    const failed = backgroundExitNoticeText(base({ status: "failed", exitCode: 137, command: "long build" }));
    expect(failed).toContain("failed");
    expect(failed).toContain("137");
    expect(failed).toContain("long build");
  });
});

describe("runDueBackgroundExitNotices — one-shot on-exit notice", () => {
  it("fires exactly once for an exited process, then dedupes on the next tick", async () => {
    await seedExited({ id: "p1", status: "exited", exitCode: 0 });
    const { broker, sent } = fakeBroker();

    const first = await runDueBackgroundExitNotices(opts({ broker, brokerUserId: "u1" }));
    expect(first).toMatchObject({ pending: 1, notified: 1, errors: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "background_process_exited", sourceId: "p1", userId: "u1" });

    // The notified sidecar is real; a second tick must NOT re-fire.
    const second = await runDueBackgroundExitNotices(opts({ broker, brokerUserId: "u1" }));
    expect(second).toMatchObject({ pending: 0, notified: 0 });
    expect(sent).toHaveLength(1);
  });

  it("survives a simulated restart: a fresh broker on the same sidecar does not double-fire", async () => {
    await seedExited({ id: "p1", status: "failed", exitCode: 1 });
    const run1 = fakeBroker();
    await runDueBackgroundExitNotices(opts({ broker: run1.broker, brokerUserId: "u1" }));
    expect(run1.sent).toHaveLength(1);

    // "Restart": new process, new broker, SAME store + notified sidecar on disk.
    const run2 = fakeBroker();
    const after = await runDueBackgroundExitNotices(opts({ broker: run2.broker, brokerUserId: "u1" }));
    expect(after).toMatchObject({ pending: 0, notified: 0 });
    expect(run2.sent).toHaveLength(0);
  });

  it("never notifies a still-running or user-killed process", async () => {
    await registerBackgroundProcess(storeFile, base({ id: "run", status: "running" }));
    await seedExited({ id: "killed", status: "killed", exitCode: null });
    const { broker, sent } = fakeBroker();
    const summary = await runDueBackgroundExitNotices(opts({ broker, brokerUserId: "u1" }));
    expect(summary.pending).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("persists the mark BEFORE delivery (fail-closed): a delivery throw leaves the id notified", async () => {
    await seedExited({ id: "p1", status: "exited", exitCode: 0 });
    const throwingBroker: AgentInitiatedNoticeBrokerLike = {
      publish() { throw new Error("broker exploded"); }
    };
    const summary = await runDueBackgroundExitNotices(opts({ broker: throwingBroker, brokerUserId: "u1" }));
    expect(summary.errors.length).toBeGreaterThan(0);

    // The id was persisted before the throw → a retry tick does NOT re-attempt.
    const notified = await readBackgroundExitNotified(notifiedFile);
    expect(notified.has("p1")).toBe(true);

    const { broker, sent } = fakeBroker();
    const retry = await runDueBackgroundExitNotices(opts({ broker, brokerUserId: "u1" }));
    expect(retry.pending).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("reports 'no sink' rather than silently marking when no delivery target is wired", async () => {
    await seedExited({ id: "p1", status: "exited", exitCode: 0 });
    const summary = await runDueBackgroundExitNotices(opts({}));
    expect(summary.errors).toEqual(["p1: no delivery sink configured"]);
  });

  it("reads back a corrupt notified sidecar as empty (never throws)", async () => {
    await writeFile(notifiedFile, "{ broken", "utf8");
    expect((await readBackgroundExitNotified(notifiedFile)).size).toBe(0);
    // and a corrupt sidecar does not block a fresh notice
    await seedExited({ id: "p1", status: "exited", exitCode: 0 });
    const { broker, sent } = fakeBroker();
    await runDueBackgroundExitNotices(opts({ broker, brokerUserId: "u1" }));
    expect(sent).toHaveLength(1);
    // the sidecar is now valid JSON holding p1
    const raw = await readFile(notifiedFile, "utf8");
    expect(JSON.parse(raw)).toEqual({ notifiedIds: ["p1"] });
  });

  describe("interruption budget (opt-in) — gates only the messaging leg", () => {
    it("cap reached: messagingRegistry.send is never called, the notice lands in the digest, and the exit is still notified (one-shot)", async () => {
      await seedExited({ id: "p1", status: "exited", exitCode: 0 });
      const sent: OutboundMessage[] = [];
      const ledgerFile = join(dir, "ledger.json");
      const digestFile = join(dir, "digest.json");
      const now = new Date("2026-07-01T10:05:00.000Z");
      await appendInterruptionDelivery(ledgerFile, { at: now, source: "background-exit" });

      const summary = await runDueBackgroundExitNotices(opts({
        destination: "555",
        interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 1, ledgerFile },
        messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
        now: () => now,
        providerId: "telegram"
      }));
      expect(summary.notified).toBe(0);
      expect(sent).toEqual([]);
      const queued = await readDigestQueue(digestFile);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ source: "background-exit", sourceId: "p1" });
      // The one-shot sidecar is unaffected — it's marked before any delivery
      // attempt, budget or not — so a suppressed exit is never re-notified.
      expect((await readBackgroundExitNotified(notifiedFile)).has("p1")).toBe(true);
    });

    it("cap not reached: delivers exactly as without a budget, and records the ledger", async () => {
      await seedExited({ id: "p1", status: "exited", exitCode: 0 });
      const sent: OutboundMessage[] = [];
      const ledgerFile = join(dir, "ledger.json");
      const digestFile = join(dir, "digest.json");
      const now = new Date("2026-07-01T10:05:00.000Z");

      const summary = await runDueBackgroundExitNotices(opts({
        destination: "555",
        interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, ledgerFile },
        messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
        now: () => now,
        providerId: "telegram"
      }));
      expect(summary.notified).toBe(1);
      expect(sent).toHaveLength(1);
      expect(await readInterruptionLedger(ledgerFile)).toHaveLength(1);
      expect(await readDigestQueue(digestFile)).toHaveLength(0);
    });

    it("interruptionBudget absent: behavior is byte-identical to the pre-budget path", async () => {
      await seedExited({ id: "p1", status: "exited", exitCode: 0 });
      const sent: OutboundMessage[] = [];
      const summary = await runDueBackgroundExitNotices(opts({
        destination: "555",
        messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
        providerId: "telegram"
      }));
      expect(summary.notified).toBe(1);
      expect(sent).toHaveLength(1);
    });

    it("a corrupt ledger file fails OPEN — the notice still sends", async () => {
      await seedExited({ id: "p1", status: "exited", exitCode: 0 });
      const sent: OutboundMessage[] = [];
      const ledgerFile = join(dir, "ledger.json");
      const digestFile = join(dir, "digest.json");
      await writeFile(ledgerFile, "{ not valid json", "utf8");

      const summary = await runDueBackgroundExitNotices(opts({
        destination: "555",
        interruptionBudget: { dailyCap: 1, digestFile, hourlyCap: 1, ledgerFile },
        messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
        providerId: "telegram"
      }));
      expect(summary.notified).toBe(1);
      expect(sent).toHaveLength(1);
    });
  });
});
