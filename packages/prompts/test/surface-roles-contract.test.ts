import { describe, expect, it } from "vitest";

import { SURFACE_ROLES } from "../src/index.js";

// The flagship `chat` role once shipped a dev placeholder ("(agent runtime) Be
// accurate…") with no assistant behavior — a 5-lens audit found it was the #1
// value gap (assistant-value-master-plan.md). These lock the load-bearing
// behavioral commitments so a future edit can't silently revert the role to a
// stub, and pin the model-agnostic invariant (no engine name in a composed role).

describe("chat surface role — assistant behavioral contract", () => {
  const chat = SURFACE_ROLES.chat;

  it("is not the retired dev placeholder", () => {
    expect(chat).not.toContain("(agent runtime)");
    expect(chat.length).toBeGreaterThan(200);
  });

  it("carries the abstain-and-offer commitment (never invent)", () => {
    expect(chat).toMatch(/never invent/iu);
    expect(chat).toMatch(/offer the next step/iu);
  });

  it("carries the action-confirmation rule (no false-done)", () => {
    expect(chat).toMatch(/tool result/iu);
    expect(chat).toMatch(/never claim it'?s done without one/iu);
  });

  it("carries the clarify-vs-assume rule (one question, only when it changes the outcome)", () => {
    expect(chat).toMatch(/ONE clarifying question/iu);
  });

  it("carries the lead-with-answer / anti-list-dump rule", () => {
    expect(chat).toMatch(/not a list-dumping engine/iu);
  });
});

describe("model-agnostic invariant — no composed role names an engine", () => {
  it("no surface role hardcodes a model/engine vendor name", () => {
    // A role is composed verbatim into the live prompt on any model; naming an
    // engine ("via local Qwen") asserts a falsehood to every other model and
    // leaks into identity answers.
    for (const [surface, text] of Object.entries(SURFACE_ROLES)) {
      expect(text, `${surface} role must not name an engine`).not.toMatch(/\b(Qwen|Gemma|GPT-?\d|Llama|Mistral)\b/u);
    }
  });
});
