import { describe, expect, it } from "vitest";

import {
  createFollowupCaptureHook,
  type CapturedFollowup
} from "../src/followup-capture-hook.js";
import type { AgentRunContext, AgentRunInput } from "../src/types.js";
import type { ModelResponse } from "@muse/model";

const fixedNow = new Date("2026-05-13T10:00:00.000Z");

function context(overrides: Partial<AgentRunInput> = {}): AgentRunContext {
  const input: AgentRunInput = {
    messages: [{ content: "...", role: "user" }],
    model: "test/model",
    metadata: { userId: "stark" } as Record<string, string>,
    ...overrides
  };
  return {
    input,
    runId: "run_test_1",
    startedAt: fixedNow
  };
}

function response(output: string): ModelResponse {
  return {
    id: "resp_1",
    model: "test/model",
    output
  };
}

describe("createFollowupCaptureHook", () => {
  it("captures an English `in N minutes` promise from the assistant output", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(context(), response("I'll ping you in 30 minutes — sound good?"));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.userId).toBe("stark");
    expect(captured[0]?.scheduledFor).toBe(new Date(fixedNow.getTime() + 30 * 60_000).toISOString());
    expect(captured[0]?.status).toBe("scheduled");
    expect(captured[0]?.originRunId).toBe("run_test_1");
    expect(captured[0]?.kind).toBe("relative-minutes");
    expect(captured[0]?.originTurnHash).toMatch(/^sha256:[0-9a-f]{32}$/u);
  });

  it("captures a Korean `N분 뒤` promise", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(context(), response("30분 뒤에 다시 확인할게요."));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe("korean-relative-minutes");
  });

  it("falls back to defaultUserId when metadata.userId is missing", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      defaultUserId: "fallback-user",
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(
      { ...context(), input: { messages: [], model: "test/model" } as AgentRunInput },
      response("in 10 min")
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.userId).toBe("fallback-user");
  });

  it("skips capture entirely when no userId is available", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(
      { ...context(), input: { messages: [], model: "test/model" } as AgentRunInput },
      response("in 10 min")
    );
    expect(captured).toEqual([]);
  });

  it("no-ops on empty output", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(context(), response(""));
    await hook.afterComplete?.(context(), response("   "));
    expect(captured).toEqual([]);
  });

  it("no-ops when nothing matches a followup pattern", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(context(), response("Sounds good — I'll get on it."));
    expect(captured).toEqual([]);
  });

  it("caps captures per turn", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      maxCapturesPerTurn: 2,
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(
      context(),
      response("in 5 min, in 10 min, in 20 min, in 40 min, tomorrow morning")
    );
    expect(captured).toHaveLength(2);
  });

  it("hashes the entire assistant turn — same text yields same hash", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    const text = "in 30 minutes";
    await hook.afterComplete?.(context(), response(text));
    await hook.afterComplete?.(context(), response(text));
    expect(captured).toHaveLength(2);
    expect(captured[0]?.originTurnHash).toBe(captured[1]?.originTurnHash);
  });

  it("swallows persist failures so the run isn't aborted", async () => {
    let calls = 0;
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: () => {
        calls += 1;
        throw new Error("disk full");
      }
    });
    // Two distinct promises so we know the failure of the first
    // didn't short-circuit the loop.
    await expect(
      hook.afterComplete?.(context(), response("in 30 minutes and tomorrow morning"))
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("dedupes promises whose scheduledFor collide", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    // Detector already collapses these (same minute) — assert the
    // hook doesn't re-emit two captures.
    await hook.afterComplete?.(context(), response("in 30 minutes — actually, in 30 min works too."));
    expect(captured).toHaveLength(1);
  });
});
