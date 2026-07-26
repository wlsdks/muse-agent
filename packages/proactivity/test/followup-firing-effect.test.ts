import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  cancelFollowup,
  readFollowups,
  snoozeFollowup,
  writeFollowups,
  type PersistedFollowup
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  followupOccurrenceEffectId,
  runDueFollowups
} from "../src/followup-firing-loop.js";

const SCHEDULED_FOR = "2026-07-26T23:00:00.000Z";
const NOW = "2026-07-27T00:00:00.000Z";
const SYNTHESIZED = "Did the deployment finish?";
const execFileAsync = promisify(execFile);
const childFixture = new URL("./fixtures/followup-firing-effect-child.ts", import.meta.url);

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-followup-effect-"));
  return {
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    followupsFile: join(dir, "followups.json")
  };
}

function followup(over: Partial<PersistedFollowup> = {}): PersistedFollowup {
  return {
    createdAt: "2026-07-26T20:00:00.000Z",
    id: "followup-effect-1",
    scheduledFor: SCHEDULED_FOR,
    status: "scheduled",
    summary: "Check whether the deployment finished",
    userId: "owner",
    ...over
  };
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
  messaging: MessagingProviderRegistry,
  calls: { synthesis: number }
) {
  return {
    destination: "@owner",
    effectFile: p.effectFile,
    file: p.followupsFile,
    model: "test-model",
    modelProvider: {
      generate: async () => {
        calls.synthesis += 1;
        return { output: SYNTHESIZED };
      }
    },
    now: () => new Date(NOW),
    providerId: "telegram",
    registry: messaging
  } as const;
}

describe("runDueFollowups durable occurrence effect", () => {
  it("binds one occurrence and marks it from the accepted provider receipt", async () => {
    const p = paths();
    await writeFollowups(p.followupsFile, [followup()]);
    const counts = { synthesis: 0 };
    const sent: OutboundMessage[] = [];
    const summary = await runDueFollowups(options(p, registry(async (message) => {
      sent.push(message);
      return { destination: message.destination, messageId: "accepted-1", providerId: "telegram" };
    }), counts));
    const effectId = followupOccurrenceEffectId("followup-effect-1", SCHEDULED_FOR);

    expect(summary.delivered).toBe(1);
    expect(counts.synthesis).toBe(1);
    expect(sent).toEqual([
      expect.objectContaining({ idempotencyKey: effectId, text: SYNTHESIZED })
    ]);
    expect((await readFollowups(p.followupsFile))[0]).toMatchObject({
      firedAt: NOW,
      status: "fired"
    });
    expect(await readOutboundEffect(p.effectFile, effectId))
      .toMatchObject({ binding: { effectId }, state: "accepted" });
  });

  it("seals provider failure and crash-left prepared as unknown without replay or resynthesis", async () => {
    const p = paths();
    await writeFollowups(p.followupsFile, [followup()]);
    const counts = { synthesis: 0 };
    let providerCalls = 0;
    const first = await runDueFollowups(options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("ambiguous timeout");
    }), counts));
    const replay = await runDueFollowups(options(p, registry(async () => {
      providerCalls += 1;
      throw new Error("must not replay");
    }), counts));
    expect(first.errors[0]).toContain("delivery is unknown");
    expect(replay.errors[0]).toContain("reconcile manually");
    expect(providerCalls).toBe(1);
    expect(counts.synthesis).toBe(1);
    expect((await readFollowups(p.followupsFile))[0]!.status).toBe("scheduled");

    const prepared = paths();
    const preparedFollowup = followup({ id: "followup-prepared" });
    await writeFollowups(prepared.followupsFile, [preparedFollowup]);
    const effectId = followupOccurrenceEffectId(preparedFollowup.id, preparedFollowup.scheduledFor);
    await prepareOutboundEffect(prepared.effectFile, {
      createdAt: NOW,
      destination: "@owner",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: "prior synthesized payload"
      }),
      providerId: "telegram"
    });
    const preparedCounts = { synthesis: 0 };
    const preparedResult = await runDueFollowups(options(prepared, registry(async () => {
      throw new Error("must not dispatch prepared");
    }), preparedCounts));
    expect(preparedResult.errors[0]).toContain("delivery is unknown");
    expect(preparedCounts.synthesis).toBe(0);
    expect(await readOutboundEffect(prepared.effectFile, effectId)).toMatchObject({ state: "unknown" });
  });

  it("repairs an accepted receipt after mark failure with no resend, resynthesis, or payload recomputation", async () => {
    const p = paths();
    const source = followup({ id: "followup-mark-repair" });
    await writeFollowups(p.followupsFile, [source]);
    const originalBytes = readFileSync(p.followupsFile, "utf8");
    const counts = { synthesis: 0 };
    let providerCalls = 0;
    const active = options(p, registry(async (message) => {
      providerCalls += 1;
      rmSync(p.followupsFile);
      mkdirSync(p.followupsFile);
      return { destination: message.destination, messageId: "accepted-before-mark", providerId: "telegram" };
    }), counts);

    const incomplete = await runDueFollowups(active);
    expect(incomplete.delivered).toBe(0);
    rmSync(p.followupsFile, { force: true, recursive: true });
    writeFileSync(p.followupsFile, originalBytes);
    const repaired = await runDueFollowups({
      ...active,
      registry: new MessagingProviderRegistry([])
    });
    expect(repaired.delivered).toBe(1);
    expect(providerCalls).toBe(1);
    expect(counts.synthesis).toBe(1);
    expect((await readFollowups(p.followupsFile))[0]).toMatchObject({ firedAt: NOW, status: "fired" });
  });

  it("uses explicit reconciliation without retry and requires a new occurrence after not-delivered", async () => {
    const accepted = paths();
    await writeFollowups(accepted.followupsFile, [followup()]);
    const acceptedCounts = { synthesis: 0 };
    let acceptedProviderCalls = 0;
    await runDueFollowups(options(accepted, registry(async () => {
      acceptedProviderCalls += 1;
      throw new Error("unknown acceptance");
    }), acceptedCounts));
    const acceptedEffectId = followupOccurrenceEffectId("followup-effect-1", SCHEDULED_FOR);
    await reconcileOutboundEffect(accepted.effectFile, {
      actor: "owner",
      decision: "accepted",
      effectId: acceptedEffectId,
      reason: "found provider receipt",
      receipt: {
        destination: "@owner",
        messageId: "manual-accepted",
        providerId: "telegram",
        receivedAt: "2026-07-27T00:00:01.000Z"
      },
      recordedAt: "2026-07-27T00:00:01.000Z"
    });
    const acceptedResult = await runDueFollowups(options(
      accepted,
      new MessagingProviderRegistry([]),
      acceptedCounts
    ));
    expect(acceptedResult.delivered).toBe(1);
    expect(acceptedProviderCalls).toBe(1);
    expect(acceptedCounts.synthesis).toBe(1);
    expect((await readFollowups(accepted.followupsFile))[0]).toMatchObject({
      firedAt: "2026-07-27T00:00:01.000Z",
      status: "fired"
    });

    const rejected = paths();
    await writeFollowups(rejected.followupsFile, [followup()]);
    const rejectedCounts = { synthesis: 0 };
    let rejectedProviderCalls = 0;
    await runDueFollowups(options(rejected, registry(async () => {
      rejectedProviderCalls += 1;
      throw new Error("unknown acceptance");
    }), rejectedCounts));
    const rejectedEffectId = followupOccurrenceEffectId("followup-effect-1", SCHEDULED_FOR);
    await reconcileOutboundEffect(rejected.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId: rejectedEffectId,
      reason: "provider has no matching message",
      recordedAt: "2026-07-27T00:00:01.000Z"
    });
    const rejectedResult = await runDueFollowups(options(rejected, registry(async () => {
      throw new Error("must not resend");
    }), rejectedCounts));
    expect(rejectedResult.delivered).toBe(0);
    expect(rejectedResult.errors[0]).toContain("snooze or upsert a new scheduled occurrence");
    expect(rejectedProviderCalls).toBe(1);
    expect(rejectedCounts.synthesis).toBe(1);
  });

  it.each(["snooze", "cancel"] as const)(
    "preserves a concurrent %s before effect acquisition with zero provider call",
    async (mutation) => {
      const p = paths();
      const source = followup({ id: `followup-${mutation}` });
      await writeFollowups(p.followupsFile, [source]);
      let providerCalls = 0;
      const result = await runDueFollowups({
        ...options(p, registry(async () => {
          providerCalls += 1;
          throw new Error("must not send stale occurrence");
        }), { synthesis: 0 }),
        modelProvider: {
          generate: async () => {
            if (mutation === "snooze") {
              await snoozeFollowup(p.followupsFile, source.id, "2026-07-28T00:00:00.000Z");
            } else {
              await cancelFollowup(p.followupsFile, source.id, "owner cancelled");
            }
            return { output: SYNTHESIZED };
          }
        }
      });
      expect(result.delivered).toBe(0);
      expect(result.errors[0]).toContain("occurrence changed before effect acquisition");
      expect(providerCalls).toBe(0);
      expect(existsSync(p.effectFile)).toBe(false);
      const current = (await readFollowups(p.followupsFile))[0]!;
      expect(current.status).toBe(mutation === "cancel" ? "cancelled" : "scheduled");
      if (mutation === "snooze") expect(current.scheduledFor).toBe("2026-07-28T00:00:00.000Z");
    }
  );

  it("preserves a concurrent cancel after provider acceptance instead of overriding it at final mark", async () => {
    const p = paths();
    const source = followup({ id: "followup-cancel-after-accept" });
    await writeFollowups(p.followupsFile, [source]);
    let providerCalls = 0;
    const result = await runDueFollowups(options(p, registry(async (message) => {
      providerCalls += 1;
      await cancelFollowup(p.followupsFile, source.id, "owner cancelled during send");
      return { destination: message.destination, messageId: "accepted-before-cancel", providerId: "telegram" };
    }), { synthesis: 0 }));
    expect(result.delivered).toBe(0);
    expect(result.errors[0]).toContain("occurrence changed before final mark");
    expect(providerCalls).toBe(1);
    expect((await readFollowups(p.followupsFile))[0]!.status).toBe("cancelled");
    expect(await readOutboundEffect(
      p.effectFile,
      followupOccurrenceEffectId(source.id, source.scheduledFor)
    )).toMatchObject({ state: "accepted" });
  });

  it("admits at most one provider call and one synthesis across two followup processes", async () => {
    const p = paths();
    await writeFollowups(p.followupsFile, [followup()]);
    const callsFile = join(p.dir, "provider-calls.txt");
    const modelCallsFile = join(p.dir, "model-calls.txt");
    const input = {
      callsFile,
      effectFile: p.effectFile,
      followupsFile: p.followupsFile,
      modelCallsFile,
      nowIso: NOW
    };
    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)]),
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)])
    ]);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const modelCalls = existsSync(modelCallsFile)
      ? readFileSync(modelCallsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(calls).toHaveLength(1);
    expect(modelCalls).toHaveLength(1);
    expect((await readFollowups(p.followupsFile))[0]!.status).toBe("fired");
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
  }, 20_000);
});
