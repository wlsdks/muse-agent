import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import {
  createMessagingObjectiveActuator,
  createModelObjectiveEvaluator
} from "../src/objective-evaluator.js";
import type { ObjectiveEvidenceDeps } from "../src/objective-evidence.js";
import { queryActionLog } from "@muse/stores";
import type { StandingObjective } from "@muse/stores";

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T08:00:00.000Z",
    id: "obj",
    kind: "until",
    spec: "tell me when it is after 2026-05-19T15:00:00Z",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

function modelReturning(output: string) {
  return { generate: async () => ({ output }) };
}

describe("createModelObjectiveEvaluator — propose → resolve → check", () => {
  it("model proposes a tasks query, the store has 3 matches ⇒ met WITH resolved evidence", async () => {
    const evidenceDeps: ObjectiveEvidenceDeps = {
      readTasks: async () => [{ title: "workout day 1" }, { title: "workout day 2" }, { title: "workout day 3" }]
    };
    const evaluate = createModelObjectiveEvaluator({
      evidenceDeps,
      model: "m",
      modelProvider: modelReturning('{"store":"tasks","keywords":["workout"],"expectedCount":3}')
    });
    const result = await evaluate(objective({ spec: "log the workout 3 times this week" }));
    expect(result.outcome).toBe("met");
    expect(result.outcome === "met" && result.evidence).toHaveLength(3);
  });

  it("model proposes a store query but the store is empty ⇒ unmet, never a bare-assertion met", async () => {
    const evaluate = createModelObjectiveEvaluator({
      evidenceDeps: { readTasks: async () => [] },
      model: "m",
      modelProvider: modelReturning('{"store":"tasks","keywords":["workout"]}')
    });
    expect(await evaluate(objective())).toEqual({ outcome: "unmet" });
  });

  it("model says store:none (nothing local can evidence it) ⇒ unmet, the honest terminal", async () => {
    const evaluate = createModelObjectiveEvaluator({
      model: "m",
      modelProvider: modelReturning('{"store":"none"}')
    });
    expect(await evaluate(objective({ spec: "let me know when it lands on the moon" }))).toEqual({ outcome: "unmet" });
  });

  it("model says store:none + unmeetable ⇒ unmeetable with reason (preserved)", async () => {
    const evaluate = createModelObjectiveEvaluator({
      model: "m",
      modelProvider: modelReturning('{"store":"none","unmeetable":true,"reason":"the repo was deleted"}')
    });
    expect(await evaluate(objective())).toEqual({ outcome: "unmeetable", reason: "the repo was deleted" });
  });

  it("malformed JSON ⇒ unmet (conservative safe default)", async () => {
    const evaluate = createModelObjectiveEvaluator({ model: "m", modelProvider: modelReturning("not json at all") });
    expect(await evaluate(objective())).toEqual({ outcome: "unmet" });
  });

  it("a store proposed with no reader injected resolves to no evidence ⇒ unmet (fail-close wiring gap)", async () => {
    const evaluate = createModelObjectiveEvaluator({
      model: "m",
      modelProvider: modelReturning('{"store":"calendar","keywords":["standup"]}')
    });
    expect(await evaluate(objective())).toEqual({ outcome: "unmet" });
  });

  it("a throwing model is fail-soft ⇒ unmet (defer, never crash the tick)", async () => {
    const evaluate = createModelObjectiveEvaluator({
      model: "m",
      modelProvider: {
        generate: async () => {
          throw new Error("ollama down");
        }
      }
    });
    expect(await evaluate(objective())).toEqual({ outcome: "unmet" });
  });
});

describe("createMessagingObjectiveActuator", () => {
  it("act + escalate deliver distinct notices over the messaging registry", async () => {
    const posts: string[] = [];
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (_url, init) => {
        posts.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      },
      token: "T"
    });
    const { act, escalate } = createMessagingObjectiveActuator({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram])
    });
    await act(objective({ spec: "ship the release" }));
    await escalate(objective({ spec: "ship the release" }), "build red 6x");
    expect(posts[0]).toBe("✅ Objective met: ship the release");
    expect(posts[1]).toBe("⚠ Objective needs you: ship the release — build red 6x");
  });

  it("act with evidence includes a compact citation (up to 3) in the met notice", async () => {
    const posts: string[] = [];
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (_url, init) => {
        posts.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      },
      token: "T"
    });
    const { act } = createMessagingObjectiveActuator({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram])
    });
    await act(objective({ spec: "log the workout 3 times this week" }), [
      { source: "task:workout day 1", text: "workout day 1", whenIso: "2026-07-08T00:00:00.000Z" },
      { source: "task:workout day 2", text: "workout day 2", whenIso: "2026-07-09T00:00:00.000Z" },
      { source: "task:workout day 3", text: "workout day 3", whenIso: "2026-07-10T00:00:00.000Z" },
      { source: "task:workout day 4", text: "workout day 4", whenIso: "2026-07-11T00:00:00.000Z" }
    ]);
    expect(posts[0]).toBe(
      "✅ Objective met: log the workout 3 times this week"
      + " — evidence: task:workout day 1 (2026-07-08T00:00:00.000Z),"
      + " task:workout day 2 (2026-07-09T00:00:00.000Z), task:workout day 3 (2026-07-10T00:00:00.000Z)"
    );
  });

  it("when actionLogFile is set, each autonomous action is appended as a reviewable rationale-bearing entry (P6), the met entry's detail carries the same evidence citation", async () => {
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { "content-type": "application/json" },
          status: 200
        }),
      token: "T"
    });
    const actionLogFile = join(mkdtempSync(join(tmpdir(), "muse-obj-act-log-")), "action-log.json");
    const { act, escalate } = createMessagingObjectiveActuator({
      actionLogFile,
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram])
    });
    await act(objective({ id: "obj_ship", spec: "ship the release", userId: "stark" }), [
      { source: "actionLog:shipped", text: "shipped", whenIso: "2026-07-10T00:00:00.000Z" }
    ]);
    await escalate(objective({ id: "obj_ship", spec: "ship the release", userId: "stark" }), "build red 6x");

    const log = await queryActionLog(actionLogFile, { userId: "stark" });
    expect(log.map((e) => ({ objectiveId: e.objectiveId, result: e.result, what: e.what, why: e.why }))).toEqual(
      expect.arrayContaining([
        { objectiveId: "obj_ship", result: "performed", what: "objective met — user notified", why: "ship the release" },
        {
          objectiveId: "obj_ship",
          result: "performed",
          what: "objective escalated — user notified",
          why: "ship the release"
        }
      ])
    );
    expect(log.find((e) => e.what.includes("met"))?.detail).toContain("evidence: actionLog:shipped");
    expect(log.find((e) => e.what.includes("escalated"))?.detail).toBe("build red 6x");
  });

  it("no actionLogFile ⇒ unchanged behaviour (delivery only, nothing logged)", async () => {
    let posted = false;
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () => {
        posted = true;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      },
      token: "T"
    });
    const { act } = createMessagingObjectiveActuator({
      destination: "555",
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram])
    });
    await act(objective());
    expect(posted).toBe(true);
  });
});
