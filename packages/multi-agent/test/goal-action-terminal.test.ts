import { describe, expect, it } from "vitest";

import {
  assessGoalActionResume,
  createGoalActionTerminalReceipt
} from "../src/goal-action-terminal.js";

const EVIDENCE_A = `sha256:${"a".repeat(64)}`;
const EVIDENCE_B = `sha256:${"b".repeat(64)}`;

describe("goal action terminal state", () => {
  it.each(["blocked", "no-progress"] as const)("records %s as an immutable terminal receipt", (terminalKind) => {
    const receipt = createGoalActionTerminalReceipt({
      actionId: "research",
      blocker: "owner credential is unavailable",
      evidenceDigest: EVIDENCE_A,
      resumeCondition: "owner supplies a valid credential",
      terminalKind
    });

    expect(receipt).toEqual({
      actionId: "research",
      blocker: "owner credential is unavailable",
      evidenceDigest: EVIDENCE_A,
      resumeCondition: "owner supplies a valid credential",
      schemaVersion: 1,
      status: terminalKind
    });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("holds the exact terminal state when evidence is missing or unchanged", () => {
    const receipt = createGoalActionTerminalReceipt({
      actionId: "research",
      blocker: "source is unavailable",
      evidenceDigest: EVIDENCE_A,
      resumeCondition: "a reachable source is provided",
      terminalKind: "blocked"
    });

    expect(assessGoalActionResume(receipt, {})).toEqual({
      decision: "held",
      reason: "missing-evidence",
      terminal: receipt
    });
    expect(assessGoalActionResume(receipt, { evidenceDigest: EVIDENCE_A })).toEqual({
      decision: "held",
      reason: "unchanged-evidence",
      terminal: receipt
    });
  });

  it("returns retry-ready, not execution authority, only for new exact evidence", () => {
    const receipt = createGoalActionTerminalReceipt({
      actionId: "research",
      blocker: "source is unavailable",
      evidenceDigest: EVIDENCE_A,
      resumeCondition: "a reachable source is provided",
      terminalKind: "no-progress"
    });
    const decision = assessGoalActionResume(receipt, { evidenceDigest: EVIDENCE_B });

    expect(decision).toEqual({
      actionId: "research",
      decision: "retry-ready",
      evidenceDigest: EVIDENCE_B,
      previousEvidenceDigest: EVIDENCE_A,
      resumeCondition: "a reachable source is provided"
    });
    expect("executionAuthorized" in decision).toBe(false);
    expect("status" in decision).toBe(false);
  });

  it("rejects inherited resume evidence instead of treating it as missing", () => {
    const receipt = createGoalActionTerminalReceipt({
      actionId: "research",
      blocker: "source is unavailable",
      evidenceDigest: EVIDENCE_A,
      resumeCondition: "a reachable source is provided",
      terminalKind: "blocked"
    });

    expect(() => assessGoalActionResume(
      receipt,
      Object.create({ evidenceDigest: EVIDENCE_B }) as { readonly evidenceDigest?: string }
    )).toThrow(/evidenceDigest/u);
  });

  it.each([
    { actionId: "", blocker: "blocked", evidenceDigest: EVIDENCE_A, resumeCondition: "later", terminalKind: "blocked" },
    { actionId: "a", blocker: "", evidenceDigest: EVIDENCE_A, resumeCondition: "later", terminalKind: "blocked" },
    { actionId: "a", blocker: "blocked", evidenceDigest: "not-a-digest", resumeCondition: "later", terminalKind: "blocked" },
    { actionId: "a", blocker: "blocked", evidenceDigest: EVIDENCE_A, resumeCondition: "", terminalKind: "blocked" },
    { actionId: "a", blocker: "blocked", evidenceDigest: EVIDENCE_A, resumeCondition: "later", terminalKind: "done" }
  ])("fails closed on malformed terminal input", (input) => {
    expect(() => createGoalActionTerminalReceipt(
      input as Parameters<typeof createGoalActionTerminalReceipt>[0]
    )).toThrow();
  });
});
