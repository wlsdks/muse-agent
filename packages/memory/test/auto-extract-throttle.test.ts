import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@muse/model";

import { createUserMemoryAutoExtractHook } from "../src/memory-auto-extract.js";
import { InMemoryUserMemoryStore } from "../src/memory-user-store.js";

/**
 * The throttle test — and the reason it exists.
 *
 * `hasSelfDisclosure` has its own unit test, and that test is not enough. When the
 * wiring was mutated back to the content-blind throttle, every one of those unit
 * tests still passed: the helper was still correct, it just was not being CALLED.
 * That is the exact failure class this whole audit was about — a function that is
 * right, tested, and never reached — and it reproduced in the very fix for it.
 *
 * So this test drives the real hook, on a clock, and asserts the STORE.
 */

/**
 * A stub that only "extracts" what the turn actually contains. A stub that returns
 * the same payload for every call is content-blind in exactly the way the bug was,
 * and it makes the test pass under the bug — the first draft of this file did
 * precisely that, and its mutation check came back green on the broken code.
 */
const honestExtractor = (): ModelProvider => ({
  generate: async (request) => {
    const said = request.messages.map((m) => m.content).join(" ");
    const facts = /penicillin|알레르기/iu.test(said) ? { allergy: "penicillin" } : {};
    return { id: "r", model: "stub", output: JSON.stringify({ facts, goals: [], preferences: {}, vetoes: [] }) };
  },
  id: "stub",
  listModels: async () => [],
  stream: async function* () {
    /* unused */
  }
});

const context = (userMessage: string) => ({
  input: {
    messages: [{ content: userMessage, role: "user" as const }],
    metadata: { userId: "stark" },
    runId: "run-1"
  }
});

const response = { output: "네, 기억할게요." };

describe("auto-extract throttle — a fact about you is never rate-limited away", () => {
  it("learns a self-disclosure that arrives inside the cooldown window", async () => {
    // The measured failure: at an ordinary typing pace (~15s between turns), a
    // content-blind 60s cooldown dropped SEVEN of seven memory-bearing turns —
    // including the user stating his own name. The window kept whichever turn
    // happened to land in it, so "lol" and "I'm allergic to penicillin" had exactly
    // the same odds. This is why the one live learning surface had learned nothing.
    const store = new InMemoryUserMemoryStore();
    let nowMs = 0;
    const hook = createUserMemoryAutoExtractHook({
      extractionCooldownMs: 60_000,
      model: "stub",
      modelProvider: honestExtractor(),
      now: () => nowMs,
      store
    });

    // Turn 1: small talk. Costs the extraction slot under the old gate.
    await hook.afterComplete?.(context("lol") as never, response as never);

    // Turn 2, fifteen seconds later: a fact that will never be said again.
    nowMs = 15_000;
    await hook.afterComplete?.(context("I'm allergic to penicillin") as never, response as never);

    const memory = await store.findByUserId("stark");
    expect(memory?.facts?.["allergy"]).toBe("penicillin");
  });

  it("still throttles an ordinary turn that discloses nothing", async () => {
    // The throttle has a real job — it stops every idle turn buying an LLM call.
    // Widening it to "never throttle anything" would trade one bug for another.
    let calls = 0;
    const store = new InMemoryUserMemoryStore();
    let nowMs = 0;
    const hook = createUserMemoryAutoExtractHook({
      extractionCooldownMs: 60_000,
      model: "stub",
      modelProvider: {
        generate: async () => {
          calls += 1;
          return { id: "r", model: "stub", output: JSON.stringify({ facts: {}, goals: [], preferences: {}, vetoes: [] }) };
        },
        id: "stub",
        listModels: async () => [],
        stream: async function* () {
          /* unused */
        }
      },
      now: () => nowMs,
      store
    });

    await hook.afterComplete?.(context("what is the capital of Portugal?") as never, response as never);
    nowMs = 15_000;
    await hook.afterComplete?.(context("and the population?") as never, response as never);
    nowMs = 30_000;
    await hook.afterComplete?.(context("thanks") as never, response as never);

    expect(calls).toBe(1);
  });
});
