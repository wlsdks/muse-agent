import { describe, expect, it } from "vitest";

import {
  BACKGROUND_REVIEW_HOOK_ID,
  createBackgroundReviewHook,
  createInMemoryReviewCounterStore,
  evaluateReviewTriggers,
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
const toolResult = {} as unknown as ToolExecutionResult;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("evaluateReviewTriggers", () => {
  it("fires a channel only once its accrued count reaches its interval; <=0 disables", () => {
    expect(evaluateReviewTriggers({ iters: 9, turns: 2 }, { memoryEveryTurns: 3, skillEveryIters: 10 })).toEqual({ reviewMemory: false, reviewSkill: false });
    expect(evaluateReviewTriggers({ iters: 10, turns: 3 }, { memoryEveryTurns: 3, skillEveryIters: 10 })).toEqual({ reviewMemory: true, reviewSkill: true });
    expect(evaluateReviewTriggers({ iters: 99, turns: 99 }, { memoryEveryTurns: 0, skillEveryIters: 0 })).toEqual({ reviewMemory: false, reviewSkill: false });
  });
});

describe("createInMemoryReviewCounterStore", () => {
  it("accumulates per user and resets only named fields", () => {
    const store = createInMemoryReviewCounterStore();
    store.increment("a", { iters: 4 });
    expect(store.increment("a", { turns: 1, iters: 2 })).toEqual({ iters: 6, turns: 1 });
    expect(store.increment("b", { turns: 1 })).toEqual({ iters: 0, turns: 1 }); // isolated per user
    store.reset("a", { turns: true });
    expect(store.increment("a", { turns: 0, iters: 0 })).toEqual({ iters: 6, turns: 0 }); // iters survived
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

  it("fires the SKILL channel once accrued tool-iterations cross the threshold (hard tasks teach)", async () => {
    const reviews: BackgroundReviewInput[] = [];
    const hook = createBackgroundReviewHook({ memoryEveryTurns: 999, runReview: (i) => { reviews.push(i); }, skillEveryIters: 3 });
    // a hard turn: 3 tool iterations, then completes
    hook.afterTool!(context(), toolCall, toolResult);
    hook.afterTool!(context(), toolCall, toolResult);
    hook.afterTool!(context(), toolCall, toolResult);
    await hook.afterComplete!(context(), response);
    await flush();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewMemory: false, reviewSkill: true });
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
