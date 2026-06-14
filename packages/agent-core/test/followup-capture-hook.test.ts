import { describe, expect, it } from "vitest";

import {
  createFollowupCaptureHook,
  sanitizeFollowupSummary,
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
      response("I'll ping you in 10 min")
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.userId).toBe("fallback-user");
  });

  it("does NOT capture a descriptive time mention — only a real self-commitment (commissive gate)", async () => {
    // Production wiring: the hook sets requireCommissive, so a descriptive sentence
    // ("your meeting is tomorrow") no longer queues a reminder the assistant never
    // promised (arXiv:2502.14321). Neutralizing hasCommissiveForce reinstates the
    // spurious capture → this test goes RED (the production-path revert-proof).
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    await hook.afterComplete?.(context(), response("Your meeting is tomorrow at 3pm and the report is due in 2 days."));
    expect(captured).toEqual([]);
    // A genuine commitment in the same shape still captures.
    await hook.afterComplete?.(context(), response("I'll follow up tomorrow at 3pm."));
    expect(captured.length).toBeGreaterThan(0);
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
      response("I'll ping you in 5 min, in 10 min, in 20 min, in 40 min, tomorrow morning")
    );
    expect(captured).toHaveLength(2);
  });

  it("hashes the entire assistant turn — same text yields same hash", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => fixedNow,
      persist: (followup) => { captured.push(followup); }
    });
    const text = "I'll ping you in 30 minutes";
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
      hook.afterComplete?.(context(), response("I'll ping you in 30 minutes and tomorrow morning"))
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
    await hook.afterComplete?.(context(), response("I'll ping you in 30 minutes — actually, in 30 min works too."));
    expect(captured).toHaveLength(1);
  });

  it("merges rule + additionalDetector output and dedupes by minute; rule wins on tie", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => new Date("2026-05-13T08:00:00Z"),
      persist: (followup) => { captured.push(followup); },
      // Turn contains ONE rule-detectable promise ("in 30 minutes" → 08:30Z).
      // LLM detector contributes two more:
      //   - 09:30Z — distinct from the rule's 08:30, must persist.
      //   - 08:30Z — collides with the rule's, should be dropped (rule
      //     comes first in the merge → its summary wins).
      additionalDetector: async () => [
        { confidence: "low", kind: "today-at", originalText: "30 min from now (LLM duplicate)", scheduledFor: new Date("2026-05-13T08:30:00Z") },
        { confidence: "low", kind: "today-at", originalText: "circle back in 90 minutes", scheduledFor: new Date("2026-05-13T09:30:00Z") }
      ]
    });
    await hook.afterComplete?.(context(), response("I'll ping you in 30 minutes — sound good?"));
    expect(captured).toHaveLength(2);
    expect(captured.map((c) => c.scheduledFor)).toEqual([
      "2026-05-13T08:30:00.000Z",
      "2026-05-13T09:30:00.000Z"
    ]);
    // The 8:30 entry came from the RULE detector (higher in the merge order),
    // so its summary reflects the original text the rule pulled — NOT the
    // LLM's "(LLM duplicate)" phrasing.
    expect(captured[0]!.summary).toContain("30 minutes");
    expect(captured[0]!.summary).not.toContain("LLM duplicate");
    expect(captured[1]!.summary).toContain("90 minutes");
  });

  it("additionalDetector errors are tolerated — rule output still persists", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => new Date("2026-05-13T08:00:00Z"),
      persist: (followup) => { captured.push(followup); },
      additionalDetector: async () => { throw new Error("model down"); }
    });
    await hook.afterComplete?.(context(), response("I'll ping you in 30 minutes."));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.scheduledFor).toBe("2026-05-13T08:30:00.000Z");
  });

  it("summary strips ANSI / control bytes that rode through from tool output", async () => {
    const captured: CapturedFollowup[] = [];
    const hook = createFollowupCaptureHook({
      now: () => new Date("2026-05-13T08:00:00Z"),
      persist: (followup) => { captured.push(followup); }
    });
    // The assistant turn echoes a control-byte payload from an upstream
    // tool result. The captured summary must NOT carry those bytes
    // into ~/.muse/followups.json (the firing daemon would otherwise
    // route them to Telegram/Slack/log verbatim).
    await hook.afterComplete?.(
      context(),
      response("\x1b[2JI'll ping you in 30 minutes \x07with control bytes.")
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.summary).not.toMatch(/\x1b/u);
    expect(captured[0]!.summary).not.toMatch(/\x07/u);
    expect(captured[0]!.summary).toContain("30 minutes");
  });
});

describe("sanitizeFollowupSummary (direct unit tests)", () => {
  it("strips ESC / BEL / NUL / DEL / C1 high-set bytes", async () => {
    expect(sanitizeFollowupSummary("a\x1bb\x07c\x00d\x7fe\x9bf")).toBe("abcdef");
  });

  it("preserves newline + tab + multi-byte Unicode", async () => {
    expect(sanitizeFollowupSummary("line1\nline2\tindented")).toBe("line1\nline2\tindented");
    expect(sanitizeFollowupSummary("Q3 메모 보내기")).toBe("Q3 메모 보내기");
  });

  it("caps to 160 chars", async () => {
    const big = "x".repeat(500);
    expect(sanitizeFollowupSummary(big).length).toBe(160);
  });

  it("drops a lone high surrogate when the 160-char cap lands inside a surrogate pair (goal-451/499 sibling)", async () => {
    // "x" * 159 + "😀" + filler — "😀" is a high+low surrogate pair
    // at indices 159 and 160. slice(0, 160) keeps the high surrogate
    // at index 159 as an orphan. The persisted summary must drop it
    // so the Telegram / Slack / log routing emits valid UTF-8.
    const big = "x".repeat(159) + "😀" + "y".repeat(50);
    const result = sanitizeFollowupSummary(big);
    // No lone high surrogate at the truncation boundary.
    expect(result.charCodeAt(result.length - 1)).not.toSatisfy(
      (c: number) => c >= 0xd800 && c <= 0xdbff
    );
    // The result is the 159 x's plus zero surrogates (the orphan
    // got dropped). Length is 159.
    expect(result).toBe("x".repeat(159));
  });
});
