import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import {
  createMessagingObjectiveActuator,
  createModelObjectiveEvaluator,
  parseObjectiveVerdict
} from "./objective-evaluator.js";
import type { StandingObjective } from "./personal-objectives-store.js";

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
});
