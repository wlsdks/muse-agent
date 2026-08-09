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
  recordOutboundEffectAccepted,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import {
  addObjective,
  patchObjective,
  readObjectives,
  type StandingObjective
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  createMessagingObjectiveActuator,
  objectiveEvaluationEffectId
} from "../src/objective-evaluator.js";
import { runDueObjectives } from "../src/objective-evaluation-loop.js";

const NOW = new Date("2026-07-27T09:00:00.000Z");
const EVIDENCE = [{
  source: "task:release",
  text: "release completed",
  whenIso: "2026-07-27T08:55:00.000Z"
}] as const;
const execFileAsync = promisify(execFile);
const childFixture = fileURLToPath(new URL("./fixtures/objective-evaluation-effect-child.ts", import.meta.url));

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-objective-effect-"));
  return {
    callsFile: join(dir, "provider-calls.txt"),
    dir,
    effectFile: join(dir, "outbound-effects.json"),
    objectivesFile: join(dir, "objectives.json")
  };
}

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-07-27T08:00:00.000Z",
    id: "objective-effect-1",
    kind: "until",
    spec: "tell me when the release completes",
    status: "active",
    userId: "owner",
    ...overrides
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

function actuator(
  p: ReturnType<typeof paths>,
  messagingRegistry: MessagingProviderRegistry
) {
  return createMessagingObjectiveActuator({
    destination: "@owner",
    effectFile: p.effectFile,
    now: () => NOW,
    providerId: "telegram",
    registry: messagingRegistry
  });
}

describe("standing-objective durable terminal effects", () => {
  it("derives one stable occurrence+terminal ID independent of mutable evaluation text", () => {
    const occurrence = objective();
    const met = objectiveEvaluationEffectId(occurrence, "met");

    expect(met).toMatch(/^objective-evaluation:[0-9a-f]{64}$/u);
    expect(objectiveEvaluationEffectId({ ...occurrence, spec: "changed text" }, "met")).toBe(met);
    expect(objectiveEvaluationEffectId(occurrence, "escalated")).not.toBe(met);
    expect(objectiveEvaluationEffectId({
      ...occurrence,
      createdAt: "2026-07-27T08:01:00.000Z"
    }, "met")).not.toBe(met);
  });

  it("uses one provider attempt, durable receipt, then a conditional terminal patch", async () => {
    const p = paths();
    const current = objective();
    await addObjective(p.objectivesFile, current);
    let providerCalls = 0;
    const direct = actuator(p, registry(async (message) => {
      providerCalls += 1;
      expect((await readObjectives(p.objectivesFile))[0]?.status).toBe("active");
      return {
        destination: message.destination,
        messageId: "accepted-objective",
        providerId: "telegram"
      };
    }));

    const summary = await runDueObjectives({
      act: direct.act,
      escalate: direct.escalate,
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file: p.objectivesFile,
      now: () => NOW,
      terminalEffects: direct
    });

    expect(summary).toMatchObject({ errors: [], fired: [current.id] });
    expect(providerCalls).toBe(1);
    expect(await readOutboundEffect(
      p.effectFile,
      objectiveEvaluationEffectId(current, "met")
    )).toMatchObject({ state: "accepted" });
    expect((await readObjectives(p.objectivesFile))[0]?.status).toBe("done");
  });

  it("repairs accepted and reconciled-accepted effects after restart with the provider removed", async () => {
    for (const mode of ["accepted", "reconciled-accepted"] as const) {
      const p = paths();
      const current = objective({ id: `objective-${mode}` });
      await addObjective(p.objectivesFile, current);
      let providerCalls = 0;
      const active = actuator(p, registry(async (message) => {
        providerCalls += 1;
        if (mode === "reconciled-accepted") {
          throw new Error("provider acceptance was ambiguous");
        }
        return {
          destination: message.destination,
          messageId: "accepted-before-patch",
          providerId: "telegram"
        };
      }));
      const effectId = objectiveEvaluationEffectId(current, "met");
      if (mode === "accepted") {
        // `act` succeeded and intentionally left the objective active because
        // this test models a restart before the loop's final patch.
        await active.act(current, EVIDENCE);
      } else {
        await expect(active.act(current, EVIDENCE)).rejects.toThrow(/unknown/iu);
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
      }

      let evaluated = 0;
      const restarted = actuator(p, new MessagingProviderRegistry([]));
      const summary = await runDueObjectives({
        act: restarted.act,
        escalate: restarted.escalate,
        evaluate: async () => {
          evaluated += 1;
          return { evidence: EVIDENCE, outcome: "met" };
        },
        file: p.objectivesFile,
        now: () => NOW,
        terminalEffects: restarted
      });
      expect(summary.fired).toEqual([current.id]);
      expect(evaluated).toBe(1);
      expect(providerCalls).toBe(1);
      expect((await readObjectives(p.objectivesFile))[0]?.status).toBe("done");
    }
  });

  it("seals unknown/prepared without retry and reconciled-not-delivered without a sink", async () => {
    const p = paths();
    const current = objective();
    await addObjective(p.objectivesFile, current);
    let providerCalls = 0;
    const active = actuator(p, registry(async () => {
      providerCalls += 1;
      throw new Error("timeout after request bytes");
    }));
    const first = await runDueObjectives({
      act: active.act,
      escalate: active.escalate,
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file: p.objectivesFile,
      now: () => NOW,
      terminalEffects: active
    });
    expect(first.errors.join("\n")).toMatch(/unknown|reconcile/iu);
    expect(providerCalls).toBe(1);

    let replayEvaluations = 0;
    const restarted = actuator(p, new MessagingProviderRegistry([]));
    const replay = await runDueObjectives({
      act: restarted.act,
      escalate: restarted.escalate,
      evaluate: async () => {
        replayEvaluations += 1;
        return { outcome: "unmeetable", reason: "drifted opposite terminal" };
      },
      file: p.objectivesFile,
      now: () => NOW,
      terminalEffects: restarted
    });
    expect(replay.errors.join("\n")).toContain("reconcile");
    expect(replayEvaluations).toBe(0);
    expect(await readOutboundEffect(
      p.effectFile,
      objectiveEvaluationEffectId(current, "escalated")
    )).toBeUndefined();

    await reconcileOutboundEffect(p.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId: objectiveEvaluationEffectId(current, "met"),
      reason: "provider history has no message",
      recordedAt: NOW.toISOString()
    });
    const sealed = await runDueObjectives({
      act: restarted.act,
      escalate: restarted.escalate,
      evaluate: async () => {
        replayEvaluations += 1;
        return { evidence: EVIDENCE, outcome: "met" };
      },
      file: p.objectivesFile,
      now: () => NOW,
      terminalEffects: restarted
    });
    expect(sealed.errors).toEqual([]);
    expect(sealed.fired).toEqual([]);
    expect(replayEvaluations).toBe(1);
    expect((await readObjectives(p.objectivesFile))[0]?.status).toBe("done");

    const prepared = paths();
    const preparedObjective = objective({ id: "objective-prepared" });
    await addObjective(prepared.objectivesFile, preparedObjective);
    const preparedEffectId = objectiveEvaluationEffectId(preparedObjective, "met");
    await prepareOutboundEffect(prepared.effectFile, {
      createdAt: NOW.toISOString(),
      destination: "@owner",
      effectId: preparedEffectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: "prepared payload is never replayed"
      }),
      providerId: "telegram"
    });
    const preparedActuator = actuator(prepared, new MessagingProviderRegistry([]));
    const preparedResult = await runDueObjectives({
      act: preparedActuator.act,
      escalate: preparedActuator.escalate,
      evaluate: async () => {
        throw new Error("prepared replay must not evaluate");
      },
      file: prepared.objectivesFile,
      now: () => NOW,
      terminalEffects: preparedActuator
    });
    expect(preparedResult.errors.join("\n")).toContain("reconcile");
    expect(await readOutboundEffect(prepared.effectFile, preparedEffectId))
      .toMatchObject({ state: "unknown" });
    expect((await readObjectives(prepared.objectivesFile))[0]?.status).toBe("active");
  });

  it("treats a blank provider receipt as unknown and never retries it", async () => {
    const p = paths();
    const current = objective({ id: "objective-blank-receipt" });
    await addObjective(p.objectivesFile, current);
    let providerCalls = 0;
    const blank = actuator(p, registry(async () => {
      providerCalls += 1;
      return {
        destination: "@owner",
        messageId: "",
        providerId: "telegram"
      };
    }));
    const first = await runDueObjectives({
      act: blank.act,
      escalate: blank.escalate,
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file: p.objectivesFile,
      now: () => NOW,
      terminalEffects: blank
    });
    const restarted = actuator(p, new MessagingProviderRegistry([]));
    const replay = await runDueObjectives({
      act: restarted.act,
      escalate: restarted.escalate,
      evaluate: async () => {
        throw new Error("unknown replay must not evaluate");
      },
      file: p.objectivesFile,
      now: () => NOW,
      terminalEffects: restarted
    });

    expect(first.errors.join("\n")).toContain("unknown");
    expect(replay.errors.join("\n")).toContain("reconcile");
    expect(providerCalls).toBe(1);
    expect(await readOutboundEffect(
      p.effectFile,
      objectiveEvaluationEffectId(current, "met")
    )).toMatchObject({ state: "unknown" });
    expect((await readObjectives(p.objectivesFile))[0]?.status).toBe("active");
  });

  it("fails closed on exact payload drift and preserves a concurrent cancellation", async () => {
    const drift = paths();
    const driftObjective = objective({ id: "objective-drift" });
    let driftCalls = 0;
    const direct = actuator(drift, registry(async (message) => {
      driftCalls += 1;
      return {
        destination: message.destination,
        messageId: "accepted-original",
        providerId: "telegram"
      };
    }));
    await direct.act(driftObjective, EVIDENCE);
    await expect(direct.act(driftObjective, [{
      source: "task:different",
      text: "different",
      whenIso: "2026-07-27T08:59:00.000Z"
    }])).rejects.toThrow(/neutralized wire payload/iu);
    expect(driftCalls).toBe(1);

    const cancelled = paths();
    const cancelledObjective = objective({ id: "objective-cancelled" });
    await addObjective(cancelled.objectivesFile, cancelledObjective);
    const cancelDuringSend = actuator(cancelled, registry(async (message) => {
      await patchObjective(cancelled.objectivesFile, cancelledObjective.id, {
        resolution: "cancelled by owner during delivery",
        status: "cancelled"
      });
      return {
        destination: message.destination,
        messageId: "accepted-after-cancel",
        providerId: "telegram"
      };
    }));
    const result = await runDueObjectives({
      act: cancelDuringSend.act,
      escalate: cancelDuringSend.escalate,
      evaluate: async () => ({ evidence: EVIDENCE, outcome: "met" }),
      file: cancelled.objectivesFile,
      now: () => NOW,
      terminalEffects: cancelDuringSend
    });
    expect(result.fired).toEqual([]);
    expect((await readObjectives(cancelled.objectivesFile))[0]).toMatchObject({
      resolution: "cancelled by owner during delivery",
      status: "cancelled"
    });
  });

  it("does not repair an accepted effect whose durable payload hash is wrong", async () => {
    const p = paths();
    const current = objective({ id: "objective-wrong-accepted-binding" });
    await addObjective(p.objectivesFile, current);
    const effectId = objectiveEvaluationEffectId(current, "met");
    await prepareOutboundEffect(p.effectFile, {
      createdAt: NOW.toISOString(),
      destination: "@owner",
      effectId,
      payloadHash: computeOutboundEffectPayloadHash({
        destination: "@owner",
        providerId: "telegram",
        text: "wrong neutralized wire payload"
      }),
      providerId: "telegram"
    });
    await recordOutboundEffectAccepted(p.effectFile, effectId, {
      destination: "@owner",
      messageId: "accepted-wrong-payload",
      providerId: "telegram",
      receivedAt: NOW.toISOString()
    }, NOW.toISOString());
    let evaluated = 0;
    const restarted = actuator(p, new MessagingProviderRegistry([]));
    const result = await runDueObjectives({
      act: restarted.act,
      escalate: restarted.escalate,
      evaluate: async () => {
        evaluated += 1;
        return { evidence: EVIDENCE, outcome: "met" };
      },
      file: p.objectivesFile,
      now: () => NOW,
      terminalEffects: restarted
    });

    expect(result.fired).toEqual([]);
    expect(result.errors.join("\n")).toContain("neutralized wire payload");
    expect(evaluated).toBe(1);
    expect((await readObjectives(p.objectivesFile))[0]?.status).toBe("active");
  });

  it("admits one provider effect and terminal patch across two OS processes", async () => {
    const p = paths();
    await addObjective(p.objectivesFile, objective());
    const input = {
      callsFile: p.callsFile,
      effectFile: p.effectFile,
      nowIso: NOW.toISOString(),
      objectivesFile: p.objectivesFile
    };
    const outputs = await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", childFixture, JSON.stringify(input)]),
      execFileAsync(process.execPath, ["--import", "tsx", childFixture, JSON.stringify(input)])
    ]);
    const calls = existsSync(p.callsFile)
      ? readFileSync(p.callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const summaries = outputs.map(({ stdout }) => JSON.parse(stdout.trim()) as {
      readonly fired: readonly string[];
    });

    expect(calls).toHaveLength(1);
    expect(await readOutboundEffects(p.effectFile)).toHaveLength(1);
    expect(summaries.flatMap(({ fired }) => fired)).toEqual(["objective-effect-1"]);
    expect((await readObjectives(p.objectivesFile))[0]?.status).toBe("done");
  }, 20_000);
});
