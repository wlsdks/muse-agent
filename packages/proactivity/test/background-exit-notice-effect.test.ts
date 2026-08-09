import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  MessagingProviderRegistry,
  computeOutboundEffectPayloadHash,
  prepareOutboundEffect,
  readOutboundEffect,
  readOutboundEffects,
  reconcileOutboundEffect,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import {
  appendInterruptionDelivery,
  recordOutcome,
  registerBackgroundProcess,
  updateBackgroundProcess
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  backgroundExitEffectId,
  backgroundExitNoticeText,
  readBackgroundExitNotified,
  runDueBackgroundExitNotices
} from "../src/background-exit-notice-loop.js";

const NOW = new Date("2026-07-01T10:05:00.000Z");
const execFileAsync = promisify(execFile);
const childFixture = fileURLToPath(new URL("./fixtures/background-exit-notice-effect-child.ts", import.meta.url));

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-background-exit-effect-"));
  return {
    callsFile: join(dir, "provider-calls.txt"),
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    notifiedFile: join(dir, "bg-exit-notified.json"),
    storeFile: join(dir, "background-processes.json")
  };
}

async function seedExited(
  p: ReturnType<typeof paths>,
  id = "background-effect-1"
): Promise<void> {
  await registerBackgroundProcess(p.storeFile, {
    command: "pnpm build",
    id,
    pid: 4242,
    startedAt: "2026-07-01T10:00:00.000Z",
    status: "running"
  });
  await updateBackgroundProcess(p.storeFile, id, {
    endedAt: NOW.toISOString(),
    exitCode: 0,
    status: "exited"
  });
}

function registry(
  send: (message: OutboundMessage) => Promise<OutboundReceipt>
): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    send
  };
  return new MessagingProviderRegistry([provider]);
}

function options(
  p: ReturnType<typeof paths>,
  messaging: MessagingProviderRegistry
) {
  return {
    destination: "@owner",
    effectFile: p.effectFile,
    messagingRegistry: messaging,
    notifiedFile: p.notifiedFile,
    now: () => NOW,
    providerId: "telegram",
    storeFile: p.storeFile
  } as const;
}

describe("background-exit durable messaging effect", () => {
  it("binds one stable record effect and marks accepted before broker publication", async () => {
    const p = paths();
    await seedExited(p);
    const sent: OutboundMessage[] = [];
    const published: string[] = [];
    const summary = await runDueBackgroundExitNotices({
      ...options(p, registry(async (message) => {
        expect((await readBackgroundExitNotified(p.notifiedFile)).has("background-effect-1")).toBe(false);
        sent.push(message);
        return { destination: message.destination, messageId: "accepted-1", providerId: "telegram" };
      })),
      broker: {
        publish: (_userId, notice) => {
          expect(readFileSync(p.notifiedFile, "utf8")).toContain("background-effect-1");
          published.push(notice.text);
        }
      },
      brokerUserId: "owner"
    });
    const effectId = backgroundExitEffectId("background-effect-1");

    expect(effectId).toMatch(/^background-exit:[0-9a-f]{64}$/u);
    expect(summary).toMatchObject({ errors: [], notified: 1, pending: 1 });
    expect(sent).toEqual([expect.objectContaining({ idempotencyKey: effectId })]);
    expect(published).toHaveLength(1);
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "accepted" });
    expect((await readBackgroundExitNotified(p.notifiedFile)).has("background-effect-1")).toBe(true);
  });

  it("seals provider failure and crash-left prepared as unknown with zero sink and no notified mark", async () => {
    const p = paths();
    await seedExited(p);
    let providerCalls = 0;
    let brokerCalls = 0;
    const active = {
      ...options(p, registry(async () => {
        providerCalls += 1;
        throw new Error("ambiguous provider timeout");
      })),
      broker: { publish: () => { brokerCalls += 1; } },
      brokerUserId: "owner"
    };
    const first = await runDueBackgroundExitNotices(active);
    const replay = await runDueBackgroundExitNotices({
      ...active,
      messagingRegistry: new MessagingProviderRegistry([])
    });
    expect(first.errors.join("\n")).toContain("delivery is unknown");
    expect(replay.errors.join("\n")).toContain("reconcile manually");
    expect(providerCalls).toBe(1);
    expect(brokerCalls).toBe(0);
    expect((await readBackgroundExitNotified(p.notifiedFile)).has("background-effect-1")).toBe(false);

    const prepared = paths();
    await seedExited(prepared, "background-prepared");
    const effectId = backgroundExitEffectId("background-prepared");
    await prepareOutboundEffect(prepared.effectFile, {
      createdAt: NOW.toISOString(),
      destination: "@owner",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: backgroundExitNoticeText({
          command: "pnpm build",
          endedAt: NOW.toISOString(),
          exitCode: 0,
          id: "background-prepared",
          pid: 4242,
          startedAt: "2026-07-01T10:00:00.000Z",
          status: "exited"
        })
      }),
      providerId: "telegram"
    });
    const preparedResult = await runDueBackgroundExitNotices(options(
      prepared,
      new MessagingProviderRegistry([])
    ));
    expect(preparedResult.errors.join("\n")).toContain("delivery is unknown");
    expect((await readBackgroundExitNotified(prepared.notifiedFile)).has("background-prepared")).toBe(false);
  });

  it("repairs accepted state provider-independently and never replays the broker", async () => {
    const p = paths();
    await seedExited(p, "background-mark-repair");
    let providerCalls = 0;
    const active = options(p, registry(async (message) => {
      providerCalls += 1;
      rmSync(p.notifiedFile, { force: true });
      mkdirSync(p.notifiedFile);
      return {
        destination: message.destination,
        messageId: "accepted-before-sidecar",
        providerId: "telegram"
      };
    }));
    const incomplete = await runDueBackgroundExitNotices(active);
    expect(incomplete.notified).toBe(0);
    rmSync(p.notifiedFile, { force: true, recursive: true });

    let brokerCalls = 0;
    const repaired = await runDueBackgroundExitNotices({
      ...active,
      broker: { publish: () => { brokerCalls += 1; } },
      brokerUserId: "owner",
      messagingRegistry: new MessagingProviderRegistry([])
    });
    expect(repaired.notified).toBe(1);
    expect(providerCalls).toBe(1);
    expect(brokerCalls).toBe(0);
    expect((await readBackgroundExitNotified(p.notifiedFile)).has("background-mark-repair")).toBe(true);
  });

  it("repairs reconciled-accepted state provider-independently with no sink replay", async () => {
    const p = paths();
    await seedExited(p, "background-reconciled-accepted");
    let providerCalls = 0;
    const active = options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("provider acceptance was ambiguous");
    }));
    await runDueBackgroundExitNotices(active);
    const effectId = backgroundExitEffectId("background-reconciled-accepted");
    await reconcileOutboundEffect(p.effectFile, {
      actor: "owner",
      decision: "accepted",
      effectId,
      reason: "confirmed in provider history",
      receipt: {
        destination: "@owner",
        messageId: "confirmed-after-timeout",
        providerId: "telegram",
        receivedAt: NOW.toISOString()
      },
      recordedAt: NOW.toISOString()
    });
    let brokerCalls = 0;
    const repaired = await runDueBackgroundExitNotices({
      ...active,
      broker: { publish: () => { brokerCalls += 1; } },
      brokerUserId: "owner",
      messagingRegistry: new MessagingProviderRegistry([])
    });

    expect(repaired).toMatchObject({ errors: [], notified: 1, pending: 1 });
    expect(providerCalls).toBe(1);
    expect(brokerCalls).toBe(0);
    expect((await readBackgroundExitNotified(p.notifiedFile)).has("background-reconciled-accepted")).toBe(true);
  });

  it("marks reconciled-not-delivered as sealed with no provider or broker sink", async () => {
    const p = paths();
    await seedExited(p, "background-not-delivered");
    let providerCalls = 0;
    const active = options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("unknown acceptance");
    }));
    await runDueBackgroundExitNotices(active);
    const effectId = backgroundExitEffectId("background-not-delivered");
    await reconcileOutboundEffect(p.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId,
      reason: "provider has no matching message",
      recordedAt: NOW.toISOString()
    });
    let brokerCalls = 0;
    const sealed = await runDueBackgroundExitNotices({
      ...active,
      broker: { publish: () => { brokerCalls += 1; } },
      brokerUserId: "owner",
      messagingRegistry: new MessagingProviderRegistry([])
    });

    expect(sealed).toMatchObject({ errors: [], notified: 0, pending: 1 });
    expect(providerCalls).toBe(1);
    expect(brokerCalls).toBe(0);
    expect((await readBackgroundExitNotified(p.notifiedFile)).has("background-not-delivered")).toBe(true);
  });

  it("keeps broker-only, digest, and veto one-shot branches effect-free", async () => {
    const brokerOnly = paths();
    await seedExited(brokerOnly, "broker-only");
    let brokerOnlyCalls = 0;
    await runDueBackgroundExitNotices({
      broker: { publish: () => { brokerOnlyCalls += 1; } },
      brokerUserId: "owner",
      effectFile: brokerOnly.effectFile,
      notifiedFile: brokerOnly.notifiedFile,
      now: () => NOW,
      storeFile: brokerOnly.storeFile
    });
    expect(brokerOnlyCalls).toBe(1);
    expect(existsSync(brokerOnly.effectFile)).toBe(false);
    expect((await readBackgroundExitNotified(brokerOnly.notifiedFile)).has("broker-only")).toBe(true);

    const digest = paths();
    await seedExited(digest, "digested");
    const interruptionFile = join(digest.dir, "interruption.json");
    await appendInterruptionDelivery(interruptionFile, { at: NOW, source: "background-exit" });
    let digestBrokerCalls = 0;
    await runDueBackgroundExitNotices({
      ...options(digest, new MessagingProviderRegistry([])),
      broker: { publish: () => { digestBrokerCalls += 1; } },
      brokerUserId: "owner",
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(digest.dir, "digest.json"),
        hourlyCap: 1,
        ledgerFile: interruptionFile
      }
    });
    expect(digestBrokerCalls).toBe(1);
    expect(existsSync(digest.effectFile)).toBe(false);
    expect((await readBackgroundExitNotified(digest.notifiedFile)).has("digested")).toBe(true);

    const veto = paths();
    await seedExited(veto, "vetoed");
    const trustFile = join(veto.dir, "trust.json");
    await recordOutcome(trustFile, "background-exit:vetoed", "vetoed", NOW.getTime());
    let vetoBrokerCalls = 0;
    await runDueBackgroundExitNotices({
      ...options(veto, new MessagingProviderRegistry([])),
      broker: { publish: () => { vetoBrokerCalls += 1; } },
      brokerUserId: "owner",
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(veto.dir, "digest.json"),
        hourlyCap: 5,
        ledgerFile: join(veto.dir, "interruption.json"),
        trustLedgerFile: trustFile
      }
    });
    expect(vetoBrokerCalls).toBe(0);
    expect(existsSync(veto.effectFile)).toBe(false);
    expect((await readBackgroundExitNotified(veto.notifiedFile)).has("vetoed")).toBe(true);
  });

  it("fails closed when the required firing lock cannot be created", async () => {
    const p = paths();
    await seedExited(p);
    const blockingParent = join(p.dir, "not-a-directory");
    await writeFile(blockingParent, "file", "utf8");
    const sent: OutboundMessage[] = [];
    const summary = await runDueBackgroundExitNotices({
      ...options(p, registry(async (message) => {
        sent.push(message);
        return { destination: message.destination, messageId: "must-not-send", providerId: "telegram" };
      })),
      notifiedFile: join(blockingParent, "notified.json")
    });
    expect(summary.outcome).toBe("lock-error");
    expect(summary.pending).toBe(0);
    expect(sent).toEqual([]);
  });

  it("admits one provider call, effect, and notified mark across two processes", async () => {
    const p = paths();
    await seedExited(p);
    const input = {
      callsFile: p.callsFile,
      effectFile: p.effectFile,
      notifiedFile: p.notifiedFile,
      nowIso: NOW.toISOString(),
      storeFile: p.storeFile
    };
    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", childFixture, JSON.stringify(input)]),
      execFileAsync(process.execPath, ["--import", "tsx", childFixture, JSON.stringify(input)])
    ]);
    const calls = existsSync(p.callsFile)
      ? readFileSync(p.callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(calls).toHaveLength(1);
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
    expect((await readBackgroundExitNotified(p.notifiedFile)).has("background-effect-1")).toBe(true);
  }, 20_000);
});
