import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateTimingSession,
  proposeExperienceLearningCandidate,
  readTimingState,
  recordTimingFeedback,
  recordTimingObservation,
  startTimingSession,
  type ActiveAttunementPolicyWriteGate
} from "./index.js";

const roots: string[] = [];
const digest = (character: string) => character.repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { force: true, recursive: true })
  ));
});

describe("event to governed adaptation journey", () => {
  it("keeps collection, delivery, feedback authority, and activation explicit", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "muse-event-governance-"))
    );
    roots.push(root);
    const file = join(root, "timing.json");
    const options = {
      idFactory: vi.fn()
        .mockReturnValueOnce("session-1")
        .mockReturnValueOnce("observation-1")
        .mockReturnValueOnce("observation-2")
        .mockReturnValueOnce("candidate-1"),
      now: () => new Date("2026-07-30T10:00:00.000Z")
    };

    // An event cannot silently enroll its source or create collection state.
    await expect(recordTimingObservation(file, "unknown-session", {
      appCategory: "writing",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-30T09:25:00.000Z",
      startedAt: "2026-07-30T09:00:00.000Z"
    }, options)).rejects.toThrow(/no timing session/u);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });

    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread-work" },
      async (threadId) => {
        expect(threadId).toBe("thread-work");
      },
      options
    );
    await recordTimingObservation(file, session.id, {
      appCategory: "writing",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-30T09:25:00.000Z",
      startedAt: "2026-07-30T09:00:00.000Z"
    }, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "research",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-30T09:55:00.000Z",
      startedAt: "2026-07-30T09:30:00.000Z"
    }, options);

    const shadow = await evaluateTimingSession(file, session.id, options);
    expect(shadow).toMatchObject({
      counterfactual: { action: "present-offer" },
      decision: "offer",
      reason: "stable-focus-category-boundary",
      ruleVersion: 3
    });
    expect(Object.keys(shadow)).not.toEqual(expect.arrayContaining([
      "deliveredAt",
      "permission",
      "recipient",
      "send"
    ]));

    const mutationGate = vi.fn();
    const gate: ActiveAttunementPolicyWriteGate = {
      run: async () => {
        mutationGate();
        throw new Error("rejected feedback must stay proposal-only");
      }
    };
    const beforeFeedback = await readTimingState(file);
    const outcome = await recordTimingFeedback(
      file,
      shadow.id,
      "rejected",
      gate,
      { ...options, now: () => new Date("2026-07-30T10:01:00.000Z") }
    );
    expect(mutationGate).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      applied: false,
      feedback: {
        outcome: "rejected",
        rollbackProposal: {
          boundary: {
            actionScope: "not-expanded",
            permission: "unchanged",
            recipient: "unchanged",
            source: "unchanged"
          },
          scope: "thread-display-timing"
        }
      },
      session: { policy: beforeFeedback.sessions[0]!.policy }
    });

    const sourceRun = {
      behaviorDigest: digest("b"),
      completedAt: "2026-07-30T10:00:00.000Z",
      evidenceClass: "controlled" as const,
      runId: "run-1"
    };
    const proposalInput = {
      activeBehaviorDigest: digest("a"),
      expectedBenefit: "Reduce interruption after an explicit rejection.",
      expiresAt: "2026-08-01T10:02:00.000Z",
      experienceId: "experience-1",
      proposedAt: "2026-07-30T10:02:00.000Z",
      proposedBehavior: "Increase the thread timing cooldown.",
      proposedChange: {
        adjustment: "increase-cooldown" as const,
        kind: "thread-timing" as const
      },
      scope: { kind: "thread-timing" as const, threadId: session.threadId },
      sourceRun
    };

    // A factual receipt is evidence only; it cannot impersonate owner feedback.
    expect(proposeExperienceLearningCandidate({
      ...proposalInput,
      outcome: {
        authority: "factual-receipt",
        outcome: "rejected",
        outcomeId: outcome.feedback.candidateId,
        recordedAt: outcome.feedback.recordedAt,
        runId: "run-1"
      } as never
    })).toBeUndefined();

    const beforeProposal = await readFile(file, "utf8");
    const proposal = proposeExperienceLearningCandidate({
      ...proposalInput,
      outcome: {
        authority: "owner-explicit",
        outcome: "rejected",
        outcomeId: "outcome-1",
        recordedAt: "2026-07-30T10:01:00.000Z",
        runId: "run-1"
      }
    });
    expect(proposal).toMatchObject({
      activation: "none",
      activeBehaviorDigestAfter: digest("a"),
      activeBehaviorDigestBefore: digest("a"),
      status: "proposed"
    });
    expect(JSON.stringify(proposal)).not.toMatch(/"permission"|"recipient"|"send"/u);
    expect(await readFile(file, "utf8")).toBe(beforeProposal);
  });
});
