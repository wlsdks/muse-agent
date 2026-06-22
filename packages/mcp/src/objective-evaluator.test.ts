import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import {
  createMessagingObjectiveActuator,
  createModelObjectiveEvaluator,
  parseObjectiveVerdict
} from "@muse/proactivity";
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

describe("parseObjectiveVerdict — strict, conservative safe default", () => {
  it("met / unmeetable(+reason) parse; everything ambiguous ⇒ unmet", () => {
    expect(parseObjectiveVerdict('{"outcome":"met"}')).toEqual({ outcome: "met" });
    expect(parseObjectiveVerdict('prose {"outcome":"unmeetable","reason":"repo deleted"} more')).toEqual({
      outcome: "unmeetable",
      reason: "repo deleted"
    });
    expect(parseObjectiveVerdict('{"outcome":"unmet"}')).toEqual({ outcome: "unmet" });
    expect(parseObjectiveVerdict('{"outcome":"unmeetable"}')).toEqual({
      outcome: "unmeetable",
      reason: "model deemed the objective unmeetable"
    });
    // garbage / no JSON / unknown outcome ⇒ safe default unmet
    expect(parseObjectiveVerdict("not json at all")).toEqual({ outcome: "unmet" });
    expect(parseObjectiveVerdict('{"outcome":"maybe"}')).toEqual({ outcome: "unmet" });
    expect(parseObjectiveVerdict('{"broken json')).toEqual({ outcome: "unmet" });
  });

  it("provider-agnostic robustness: fenced / <think>-wrapped / prose-flanked verdicts parse (not silent unmet)", () => {
    // markdown code fence (the single most common LLM JSON shape)
    expect(parseObjectiveVerdict('```json\n{"outcome":"met"}\n```')).toEqual({ outcome: "met" });
    // reasoning-model leak: a brace-bearing <think> then the real
    // verdict — the OLD greedy /\{[\s\S]*\}/ spanned both → invalid
    // JSON → silent unmet (a MET objective would never complete).
    expect(
      parseObjectiveVerdict('<think>maybe {state: open}? after 3pm so yes</think>\n{"outcome":"met"}')
    ).toEqual({ outcome: "met" });
    // prose either side; take the verdict object
    expect(parseObjectiveVerdict('Sure — here is the verdict:\n{"outcome":"unmeetable","reason":"repo gone"}\nDone.'))
      .toEqual({ outcome: "unmeetable", reason: "repo gone" });
    // a non-verdict object before the real one must not shadow it;
    // the LAST recognised-outcome object wins
    expect(parseObjectiveVerdict('{"note":"context"} {"outcome":"met"}')).toEqual({ outcome: "met" });
    // `}` inside a string value must not close the object early
    expect(parseObjectiveVerdict('{"outcome":"unmeetable","reason":"saw a } brace"}')).toEqual({
      outcome: "unmeetable",
      reason: "saw a } brace"
    });
    // still conservative: a fence with no recognised outcome ⇒ unmet
    expect(parseObjectiveVerdict("```\n{\"status\":\"ok\"}\n```")).toEqual({ outcome: "unmet" });
  });
});

describe("createModelObjectiveEvaluator", () => {
  it("returns the parsed verdict for a clean model response", async () => {
    const evaluate = createModelObjectiveEvaluator({ model: "m", modelProvider: modelReturning('{"outcome":"met"}') });
    expect(await evaluate(objective())).toEqual({ outcome: "met" });
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

  it("when actionLogFile is set, each autonomous action is appended as a reviewable rationale-bearing entry (P6)", async () => {
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
    await act(objective({ id: "obj_ship", spec: "ship the release", userId: "stark" }));
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

describe("parseObjectiveVerdict — <think> stripping is linear (no ReDoS)", () => {
  it("strips complete blocks, case-insensitively, and keeps an unclosed tail", () => {
    expect(parseObjectiveVerdict('<think>reasoning</think>{"outcome":"met"}').outcome).toBe("met");
    expect(parseObjectiveVerdict('<Think>x</THINK>{"outcome":"met"}').outcome).toBe("met");
    // unclosed <think> must not swallow the JSON that follows
    expect(parseObjectiveVerdict('<think>no close {"outcome":"met"}').outcome).toBe("met");
    expect(parseObjectiveVerdict('<think>a</think>mid<think>b</think>{"outcome":"unmeetable"}').outcome).toBe("unmeetable");
  });

  it("does not blow up on many unclosed <think> tags (was O(n²))", () => {
    const start = Date.now();
    const verdict = parseObjectiveVerdict("<think>".repeat(200_000));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(verdict.outcome).toBe("unmet"); // conservative default, no JSON present
  });
});
