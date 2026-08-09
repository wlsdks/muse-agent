import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
import { appendInterruptionDelivery, recordOutcome } from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  cancelCheckin,
  checkinOccurrenceEffectId,
  readCheckins,
  runDueCheckins,
  snoozeCheckin,
  writeCheckins,
  type PersistedCheckin
} from "../src/commitment-checkin.js";

const DUE_AT = "2026-07-26T23:00:00.000Z";
const NOW = "2026-07-27T00:00:00.000Z";
const execFileAsync = promisify(execFile);
const childFixture = fileURLToPath(new URL("./fixtures/commitment-checkin-effect-child.ts", import.meta.url));

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-checkin-effect-"));
  return {
    checkinsFile: join(dir, "checkins.json"),
    dir,
    effectFile: join(dir, "outbound-effects.json")
  };
}

function checkin(over: Partial<PersistedCheckin> = {}): PersistedCheckin {
  return {
    commitment: "Check whether the deployment finished",
    createdAt: "2026-07-26T20:00:00.000Z",
    dueAtIso: DUE_AT,
    id: "checkin-effect-1",
    question: "Did the deployment finish?",
    sourceKey: "check whether the deployment finished",
    status: "scheduled",
    userId: "owner",
    ...over
  };
}

function registry(send: (message: OutboundMessage) => Promise<OutboundReceipt>): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: "telegram" }),
    id: "telegram",
    send
  };
  return new MessagingProviderRegistry([provider]);
}

function options(p: ReturnType<typeof paths>, messaging: MessagingProviderRegistry) {
  return {
    destination: "@owner",
    effectFile: p.effectFile,
    file: p.checkinsFile,
    now: () => new Date(NOW),
    providerId: "telegram",
    registry: messaging
  } as const;
}

describe("runDueCheckins durable occurrence effect", () => {
  it("uses the global commitment-checkin namespace and marks from the accepted receipt", async () => {
    const p = paths();
    await writeCheckins(p.checkinsFile, [checkin()]);
    const sent: OutboundMessage[] = [];
    const summary = await runDueCheckins(options(p, registry(async (message) => {
      sent.push(message);
      return { destination: message.destination, messageId: "accepted-1", providerId: "telegram" };
    })));
    const effectId = checkinOccurrenceEffectId("checkin-effect-1");

    expect(effectId).toMatch(/^commitment-checkin:[0-9a-f]{64}$/u);
    expect(summary.delivered).toBe(1);
    expect(sent).toEqual([expect.objectContaining({ idempotencyKey: effectId, text: "Did the deployment finish?" })]);
    expect((await readCheckins(p.checkinsFile))[0]).toMatchObject({ firedAt: NOW, status: "fired" });
    expect(await readOutboundEffect(p.effectFile, effectId)).toMatchObject({ state: "accepted" });
  });

  it("seals provider failure and crash-left prepared as unknown without replay", async () => {
    const p = paths();
    await writeCheckins(p.checkinsFile, [checkin()]);
    let providerCalls = 0;
    const first = await runDueCheckins(options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("ambiguous timeout");
    })));
    const replay = await runDueCheckins(options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("must not replay");
    })));
    expect(first.errors[0]).toContain("delivery is unknown");
    expect(replay.errors[0]).toContain("reconcile manually");
    expect(providerCalls).toBe(1);

    const prepared = paths();
    const source = checkin({ id: "checkin-prepared" });
    await writeCheckins(prepared.checkinsFile, [source]);
    const effectId = checkinOccurrenceEffectId(source.id);
    await prepareOutboundEffect(prepared.effectFile, {
      createdAt: NOW,
      destination: "@owner",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: source.question
      }),
      providerId: "telegram"
    });
    const preparedResult = await runDueCheckins(options(prepared, new MessagingProviderRegistry([])));
    expect(preparedResult.errors[0]).toContain("delivery is unknown");
    expect(await readOutboundEffect(prepared.effectFile, effectId)).toMatchObject({ state: "unknown" });
  });

  it("repairs accepted state from its receipt with the provider removed and no resend", async () => {
    const p = paths();
    const source = checkin({ id: "checkin-mark-repair" });
    await writeCheckins(p.checkinsFile, [source]);
    let providerCalls = 0;
    const active = options(p, registry(async (message) => {
      providerCalls += 1;
      const current = await readCheckins(p.checkinsFile);
      await writeCheckins(p.checkinsFile, cancelCheckin(current, source.id).checkins);
      return {
        destination: message.destination,
        messageId: "accepted-before-cancel",
        providerId: "telegram"
      };
    }));
    const incomplete = await runDueCheckins(active);
    expect(incomplete.delivered).toBe(0);
    expect((await readCheckins(p.checkinsFile))[0]!.status).toBe("cancelled");

    await writeCheckins(p.checkinsFile, [source]);
    const repaired = await runDueCheckins({ ...active, registry: new MessagingProviderRegistry([]) });
    expect(repaired.delivered).toBe(1);
    expect(providerCalls).toBe(1);
    expect((await readCheckins(p.checkinsFile))[0]).toMatchObject({ firedAt: NOW, status: "fired" });
  });

  it("rejects an accepted effect when the same id is restored with a changed wire payload", async () => {
    const p = paths();
    const source = checkin({ id: "checkin-binding-drift", question: "Did the old deployment finish?" });
    await writeCheckins(p.checkinsFile, [source]);
    let providerCalls = 0;
    const active = options(p, registry(async (message) => {
      providerCalls += 1;
      const current = await readCheckins(p.checkinsFile);
      await writeCheckins(p.checkinsFile, cancelCheckin(current, source.id).checkins);
      return {
        destination: message.destination,
        messageId: "accepted-old-question",
        providerId: "telegram"
      };
    }));
    const incomplete = await runDueCheckins(active);
    expect(incomplete.delivered).toBe(0);

    await writeCheckins(p.checkinsFile, [{
      ...source,
      question: "Did the new deployment finish?",
      status: "scheduled"
    }]);
    const replay = await runDueCheckins({
      ...active,
      registry: new MessagingProviderRegistry([])
    });

    expect(replay.delivered).toBe(0);
    expect(replay.errors.join("\n")).toContain("binding conflicts with the current check-in");
    expect(providerCalls).toBe(1);
    expect((await readCheckins(p.checkinsFile))[0]).toMatchObject({
      question: "Did the new deployment finish?",
      status: "scheduled"
    });
  });

  it("honours manual accepted/not-delivered reconciliation without a second provider call", async () => {
    const accepted = paths();
    await writeCheckins(accepted.checkinsFile, [checkin()]);
    let acceptedCalls = 0;
    await runDueCheckins(options(accepted, registry(async () => {
      acceptedCalls += 1;
      throw new Error("unknown acceptance");
    })));
    const effectId = checkinOccurrenceEffectId("checkin-effect-1");
    await reconcileOutboundEffect(accepted.effectFile, {
      actor: "owner",
      decision: "accepted",
      effectId,
      reason: "found provider receipt",
      receipt: {
        destination: "@owner",
        messageId: "manual-accepted",
        providerId: "telegram",
        receivedAt: "2026-07-27T00:00:01.000Z"
      },
      recordedAt: "2026-07-27T00:00:01.000Z"
    });
    const acceptedResult = await runDueCheckins(options(accepted, new MessagingProviderRegistry([])));
    expect(acceptedResult.delivered).toBe(1);
    expect(acceptedCalls).toBe(1);
    expect((await readCheckins(accepted.checkinsFile))[0]).toMatchObject({
      firedAt: "2026-07-27T00:00:01.000Z",
      status: "fired"
    });

    const rejected = paths();
    await writeCheckins(rejected.checkinsFile, [checkin()]);
    let rejectedCalls = 0;
    await runDueCheckins(options(rejected, registry(async () => {
      rejectedCalls += 1;
      throw new Error("unknown acceptance");
    })));
    await reconcileOutboundEffect(rejected.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId,
      reason: "provider has no matching message",
      recordedAt: "2026-07-27T00:00:01.000Z"
    });
    const current = await readCheckins(rejected.checkinsFile);
    await writeCheckins(
      rejected.checkinsFile,
      snoozeCheckin(current, "checkin-effect-1", "2026-07-26T23:30:00.000Z").checkins
    );
    const rejectedResult = await runDueCheckins(options(rejected, registry(async () => {
      throw new Error("must not resend");
    })));
    expect(rejectedResult.delivered).toBe(0);
    expect(rejectedResult.errors[0]).toContain("cancel and replace it with a fresh check-in ID");
    expect(rejectedResult.errors[0]).toContain("snoozing retains this effect ID");
    expect(rejectedCalls).toBe(1);
    expect(await readOutboundEffects(rejected.effectFile)).toHaveLength(1);
  });

  it("creates no effect for an absent route, quiet/future/cancelled item, digest, or veto", async () => {
    const absent = paths();
    await writeCheckins(absent.checkinsFile, [checkin()]);
    const absentResult = await runDueCheckins(options(absent, new MessagingProviderRegistry([])));
    expect(absentResult.delivered).toBe(0);
    expect(existsSync(absent.effectFile)).toBe(false);

    const quiet = paths();
    await writeCheckins(quiet.checkinsFile, [checkin()]);
    await runDueCheckins({ ...options(quiet, new MessagingProviderRegistry([])), quietHours: { end: 1, start: 23 } });
    expect(existsSync(quiet.effectFile)).toBe(false);

    const inert = paths();
    await writeCheckins(inert.checkinsFile, [
      checkin({ dueAtIso: "2026-07-28T00:00:00.000Z", id: "future" }),
      checkin({ id: "cancelled", status: "cancelled" })
    ]);
    await runDueCheckins(options(inert, new MessagingProviderRegistry([])));
    expect(existsSync(inert.effectFile)).toBe(false);

    const digest = paths();
    await writeCheckins(digest.checkinsFile, [checkin()]);
    await appendInterruptionDelivery(join(digest.dir, "interruption.json"), {
      at: new Date(NOW),
      source: "commitment-checkin"
    });
    await runDueCheckins({
      ...options(digest, registry(async () => { throw new Error("digest must not send"); })),
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(digest.dir, "digest.json"),
        hourlyCap: 1,
        ledgerFile: join(digest.dir, "interruption.json")
      }
    });
    expect(existsSync(digest.effectFile)).toBe(false);

    const veto = paths();
    await writeCheckins(veto.checkinsFile, [checkin()]);
    const trustFile = join(veto.dir, "trust.json");
    await recordOutcome(trustFile, "commitment-checkin:check whether the deployment finished", "vetoed", Date.parse(NOW));
    await runDueCheckins({
      ...options(veto, registry(async () => { throw new Error("veto must not send"); })),
      interruptionBudget: {
        dailyCap: 5,
        digestFile: join(veto.dir, "digest.json"),
        hourlyCap: 5,
        ledgerFile: join(veto.dir, "interruption.json"),
        trustLedgerFile: trustFile
      }
    });
    expect(existsSync(veto.effectFile)).toBe(false);
  });

  it("admits one provider call and one effect across two check-in processes", async () => {
    const p = paths();
    await writeCheckins(p.checkinsFile, [checkin()]);
    const callsFile = join(p.dir, "provider-calls.txt");
    const input = {
      callsFile,
      checkinsFile: p.checkinsFile,
      effectFile: p.effectFile,
      nowIso: NOW
    };
    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", childFixture, JSON.stringify(input)]),
      execFileAsync(process.execPath, ["--import", "tsx", childFixture, JSON.stringify(input)])
    ]);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(calls).toHaveLength(1);
    expect((await readCheckins(p.checkinsFile))[0]!.status).toBe("fired");
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
  }, 20_000);
});
