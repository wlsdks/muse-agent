import { describe, expect, it } from "vitest";

import {
  BACKGROUND_REVIEW_HOOK_ID,
  createBackgroundReviewHook,
  createInMemoryReviewCounterStore,
  evaluateReviewTriggers,
  isSkillReviewSalient,
  type BackgroundReviewInput
} from "../src/background-review.js";
import type { AgentRunContext, AgentRunInput } from "../src/types.js";
import type { ModelResponse, ModelToolCall, ToolExecutionResult } from "@muse/model";

const startedAt = new Date("2026-05-13T10:00:00.000Z");

function context(userId: string | null = "stark"): AgentRunContext {
  const input: AgentRunInput = {
    messages: [{ content: "hi", role: "user" }],
    model: "test/model",
    ...(userId !== null ? { metadata: { userId } as Record<string, string> } : {})
  };
  return { input, runId: "run_1", startedAt };
}

const response: ModelResponse = { id: "r1", model: "test/model", output: "ok" };
const toolCall = { id: "t1", input: {}, name: "noop" } as unknown as ModelToolCall;
const okToolResult = { id: "t1", name: "noop", output: "ok", status: "completed" } as unknown as ToolExecutionResult;
const failedToolResult = { error: "boom", id: "t1", name: "noop", output: "", status: "failed" } as unknown as ToolExecutionResult;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("evaluateReviewTriggers", () => {
  it("fires a channel only once its accrued count reaches its interval; <=0 disables (cadence-only, no salience)", () => {
    expect(evaluateReviewTriggers({ iters: 9, toolFailures: 0, turns: 2 }, { memoryEveryTurns: 3, skillEveryIters: 10 })).toEqual({ reviewMemory: false, reviewSkill: false });
    expect(evaluateReviewTriggers({ iters: 10, toolFailures: 0, turns: 3 }, { memoryEveryTurns: 3, skillEveryIters: 10 })).toEqual({ reviewMemory: true, reviewSkill: true });
    expect(evaluateReviewTriggers({ iters: 99, toolFailures: 0, turns: 99 }, { memoryEveryTurns: 0, skillEveryIters: 0 })).toEqual({ reviewMemory: false, reviewSkill: false });
  });

  it("salience gate: at cadence, the SKILL channel needs a tool failure in the window; MEMORY is unaffected", () => {
    const counters = { iters: 10, toolFailures: 0, turns: 3 };
    const config = { memoryEveryTurns: 3, skillEveryIters: 10 };
    // clean window (0 failures) → skill suppressed, memory still fires
    expect(evaluateReviewTriggers(counters, config, { toolCalls: 10, toolFailures: 0 })).toEqual({ reviewMemory: true, reviewSkill: false });
    // a failure in the window → skill fires
    expect(evaluateReviewTriggers({ ...counters, toolFailures: 1 }, config, { toolCalls: 10, toolFailures: 1 })).toEqual({ reviewMemory: true, reviewSkill: true });
    // salience can't manufacture a skill review before cadence is met
    expect(evaluateReviewTriggers({ iters: 9, toolFailures: 5, turns: 3 }, config, { toolCalls: 9, toolFailures: 5 })).toMatchObject({ reviewSkill: false });
  });

  it("isSkillReviewSalient: true iff a tool failed in the window", () => {
    expect(isSkillReviewSalient({ toolCalls: 10, toolFailures: 0 })).toBe(false);
    expect(isSkillReviewSalient({ toolCalls: 10, toolFailures: 1 })).toBe(true);
  });
});

describe("createInMemoryReviewCounterStore", () => {
  it("accumulates per user and resets only named fields", () => {
    const store = createInMemoryReviewCounterStore();
    store.increment("a", { iters: 4 });
    expect(store.increment("a", { turns: 1, iters: 2 })).toEqual({ iters: 6, toolFailures: 0, turns: 1 });
    expect(store.increment("b", { turns: 1 })).toEqual({ iters: 0, toolFailures: 0, turns: 1 }); // isolated per user
    store.reset("a", { turns: true });
    expect(store.increment("a", { turns: 0, iters: 0 })).toEqual({ iters: 6, toolFailures: 0, turns: 0 }); // iters survived
  });

  it("accrues toolFailures and resets them with the skill (iters) channel", () => {
    const store = createInMemoryReviewCounterStore();
    store.increment("a", { iters: 1, toolFailures: 1 });
    expect(store.increment("a", { iters: 1, toolFailures: 0 })).toEqual({ iters: 2, toolFailures: 1, turns: 0 });
    store.reset("a", { iters: true, toolFailures: true });
    expect(store.increment("a", {})).toEqual({ iters: 0, toolFailures: 0, turns: 0 });
  });
});

describe("createBackgroundReviewHook", () => {
  it("has the stable hook id and never reviews on a cheap turn (below both intervals)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 3, runReview: (i) => { reviews.push(i); }, skillEveryIters: 10 });
    expect(hook.id).toBe(BACKGROUND_REVIEW_HOOK_ID);
    await hook.afterComplete!(context(), response); // turn 1, 0 iters → nothing
    await flush();
    expect(reviews).toEqual([]);
  });

  it("fires the MEMORY channel on the Nth turn and resets the turn counter", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 2, runReview: (i) => { reviews.push(i); }, skillEveryIters: 999 });
    await hook.afterComplete!(context(), response); // turn 1
    await flush();
    expect(reviews).toEqual([]);
    await hook.afterComplete!(context(), response); // turn 2 → memory fires
    await flush();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewMemory: true, reviewSkill: false, userId: "stark" });
    // counter reset: two more turns needed before it fires again
    await hook.afterComplete!(context(), response);
    await flush();
    expect(reviews).toHaveLength(1);
  });

  it("fires the SKILL channel when a hard turn crosses the iter threshold AND had a tool failure (salience gate)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 999, runReview: (i) => { reviews.push(i); }, skillEveryIters: 3 });
    // a hard turn: 3 tool iterations, one of which FAILED → salient → skill review
    hook.afterTool!(context(), toolCall, okToolResult);
    hook.afterTool!(context(), toolCall, failedToolResult);
    hook.afterTool!(context(), toolCall, okToolResult);
    await hook.afterComplete!(context(), response);
    await flush();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewMemory: false, reviewSkill: true });
  });

  it("does NOT fire the SKILL channel on a clean turn at threshold (no tool failure → not salient)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 999, runReview: (i) => { reviews.push(i); }, skillEveryIters: 3 });
    // 3 tool iterations, ALL successful → cadence met but window not salient → suppressed
    hook.afterTool!(context(), toolCall, okToolResult);
    hook.afterTool!(context(), toolCall, okToolResult);
    hook.afterTool!(context(), toolCall, okToolResult);
    await hook.afterComplete!(context(), response);
    await flush();
    expect(reviews).toEqual([]);
    // and the cadence is NOT lost — the very next failing tool trips it
    hook.afterTool!(context(), toolCall, failedToolResult);
    await hook.afterComplete!(context(), response);
    await flush();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewSkill: true });
  });

  it("swallows a throwing review (fail-soft, never blocks the turn)", async () => {
    const errors: unknown[] = [];
    const hook = createBackgroundReviewHook({
      memoryEveryTurns: 1,
      onError: (e) => { errors.push(e); },
      runReview: () => { throw new Error("review boom"); },
      skillEveryIters: 999
    });
    expect(() => hook.afterComplete!(context(), response)).not.toThrow(); // non-blocking: returns sync
    await flush();
    expect((errors[0] as Error).message).toBe("review boom");
  });

  it("a FAILED review does NOT consume its trigger — it re-fires next eligible turn (no trigger lost)", async () => {
    // Same "no trigger is lost" invariant the in-flight-skip path holds: a review
    // whose learning arm throws (local model down, store write error) must leave
    // its trigger tripped so the accrued signal re-fires, not silently dropped
    // (MAST fail-close, arXiv:2503.13657). memoryEveryTurns:2 exposes it — a reset
    // BEFORE the (failing) review would drop turn-2's trigger and turn 3 (count 1)
    // would not re-fire.
    const reviews: BackgroundReviewInput[] = [];
    let failNext = true;
    const hook = createBackgroundReviewHook({
      memoryEveryTurns: 2,
      skillEveryIters: 999,
      onError: () => {},
      runReview: async (input) => {
        if (failNext) { failNext = false; throw new Error("arm boom"); }
        reviews.push(input);
      }
    });
    await hook.afterComplete!(context(), response); // turn 1 → count 1, no trip
    await flush();
    await hook.afterComplete!(context(), response); // turn 2 → count 2 → trips → review FAILS
    await flush();
    expect(reviews).toHaveLength(0); // failed; nothing learned yet
    await hook.afterComplete!(context(), response); // turn 3 → trigger survived → re-fires → succeeds
    await flush();
    expect(reviews).toHaveLength(1); // the lost trigger re-fired (was 0 with the pre-review reset)
  });

  it("runs only ONE review per user at a time, then coalesces the skipped trigger into a re-fire", async () => {
    const reviews: BackgroundReviewInput[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hook = createBackgroundReviewHook({
      memoryEveryTurns: 1,
      runReview: async (i) => { reviews.push(i); await gate; },
      skillEveryIters: 999
    });
    await hook.afterComplete!(context(), response); // turn 1 → trips, review starts and BLOCKS on gate
    await flush();
    expect(reviews).toHaveLength(1);
    await hook.afterComplete!(context(), response); // turn 2 → trips again, but a review is in flight → skipped
    await flush();
    expect(reviews).toHaveLength(1); // no concurrent second pass
    release!(); // first review finishes → in-flight clears
    await flush();
    await hook.afterComplete!(context(), response); // turn 3 → counter was never reset while skipped → fires now
    await flush();
    expect(reviews).toHaveLength(2);
  });

  it("isolates the in-flight guard per user (one user's running review never blocks another's)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const gate = new Promise<void>(() => { /* never resolves */ });
    const hook = createBackgroundReviewHook({
      memoryEveryTurns: 1,
      runReview: async (i) => { reviews.push(i); await gate; },
      skillEveryIters: 999
    });
    await hook.afterComplete!(context("alice"), response); // alice's review starts and hangs
    await flush();
    await hook.afterComplete!(context("bob"), response); // bob is independent → still fires
    await flush();
    expect(reviews.map((r) => r.userId).sort()).toEqual(["alice", "bob"]);
  });

  it("skips a run with no resolvable userId (no metadata, no default)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 1, runReview: (i) => { reviews.push(i); } });
    hook.afterComplete!(context(null), response); // null → no metadata.userId, no defaultUserId
    await flush();
    expect(reviews).toEqual([]);
  });
});
