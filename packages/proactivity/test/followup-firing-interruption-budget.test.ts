import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { appendInterruptionDelivery, readDigestQueue, readFollowups, readInterruptionLedger, upsertFollowup } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDueFollowups } from "../src/followup-firing-loop.js";
import type { ProactiveModelProviderLike } from "../src/proactive-notice-loop.js";

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

const fakeModel: ProactiveModelProviderLike = {
  generate: async () => ({ output: "hey — did you send that email?" })
};

let dir: string;
let followupsFile: string;
let ledgerFile: string;
let digestFile: string;
const NOW = new Date("2026-07-11T12:00:00.000Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-followup-budget-"));
  followupsFile = join(dir, "followups.json");
  ledgerFile = join(dir, "ledger.json");
  digestFile = join(dir, "digest.json");
  await upsertFollowup(followupsFile, {
    createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    id: "f1",
    scheduledFor: new Date(NOW.getTime() - 60_000).toISOString(),
    status: "scheduled",
    summary: "check whether you sent the email",
    userId: "stark"
  });
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runDueFollowups — interruption budget (opt-in)", () => {
  it("cap reached: registry.send is never called, the composed text lands in the digest, and the followup is still marked fired", async () => {
    const sent: OutboundMessage[] = [];
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "followup" });

    const summary = await runDueFollowups({
      destination: "555",
      file: followupsFile,
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 1, ledgerFile },
      model: "test-model",
      modelProvider: fakeModel,
      now: () => NOW,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(summary.delivered).toBe(0);
    expect(sent).toEqual([]);
    expect((await readFollowups(followupsFile))[0]!.status).toBe("fired");
    const queued = await readDigestQueue(digestFile);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ source: "followup", sourceId: "f1" });
  });

  it("cap not reached: delivers exactly as without a budget, and records the ledger", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDueFollowups({
      destination: "555",
      file: followupsFile,
      interruptionBudget: { dailyCap: 6, digestFile, hourlyCap: 2, ledgerFile },
      model: "test-model",
      modelProvider: fakeModel,
      now: () => NOW,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect((await readFollowups(followupsFile))[0]!.status).toBe("fired");
    expect(await readInterruptionLedger(ledgerFile)).toHaveLength(1);
    expect(await readDigestQueue(digestFile)).toHaveLength(0);
  });

  it("interruptionBudget absent: behavior is byte-identical to the pre-budget path", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDueFollowups({
      destination: "555",
      file: followupsFile,
      model: "test-model",
      modelProvider: fakeModel,
      now: () => NOW,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("a corrupt ledger file fails OPEN — the followup still sends", async () => {
    const sent: OutboundMessage[] = [];
    await writeFile(ledgerFile, "{ not valid json", "utf8");
    const summary = await runDueFollowups({
      destination: "555",
      file: followupsFile,
      interruptionBudget: { dailyCap: 1, digestFile, hourlyCap: 1, ledgerFile },
      model: "test-model",
      modelProvider: fakeModel,
      now: () => NOW,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
