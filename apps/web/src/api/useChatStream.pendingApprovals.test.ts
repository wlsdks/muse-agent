import { describe, expect, it, vi } from "vitest";

import {
  applyApprove,
  applyApproveOutcome,
  handleEvent,
  readPendingApprovals
} from "./useChatStream.js";

import type { ChatTurn } from "./useChatStream.js";
import type { ChatResponse, PendingApproval } from "./types.js";

const noop = () => {};

const A1: PendingApproval = { draft: "Hi Sam — running late, start without me.", id: "a1", tool: "send_message" };
const A2: PendingApproval = { draft: "Book table for 4 at 7pm.", id: "a2", tool: "make_reservation" };

function assistantTurn(pendingApprovals?: readonly PendingApproval[]): ChatTurn {
  return { pendingApprovals, role: "assistant", text: "Drafted it for you." };
}

describe("handleEvent — the pending-approvals SSE frame", () => {
  it("attaches the parsed approvals to the current assistant draft turn", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);

    handleEvent("pending-approvals", JSON.stringify({ pendingApprovals: [A1, A2] }), commit, noop, noop);

    expect(turn.pendingApprovals).toEqual([A1, A2]);
  });

  it("ignores a malformed frame instead of throwing, leaving the turn untouched", () => {
    const turn = assistantTurn();
    const commit = vi.fn((mut: (t: ChatTurn) => void) => mut(turn));

    expect(() => handleEvent("pending-approvals", "{not json", commit, noop, noop)).not.toThrow();
    expect(commit).not.toHaveBeenCalled();
    expect(turn.pendingApprovals).toBeUndefined();
  });

  it("does not attach an empty array (no approvals means no block)", () => {
    const turn = assistantTurn();
    const commit = vi.fn((mut: (t: ChatTurn) => void) => mut(turn));

    handleEvent("pending-approvals", JSON.stringify({ pendingApprovals: [] }), commit, noop, noop);

    expect(commit).not.toHaveBeenCalled();
    expect(turn.pendingApprovals).toBeUndefined();
  });
});

describe("readPendingApprovals — the non-streaming JSON fallback path", () => {
  it("reads a present array off the body", () => {
    const body = { pendingApprovals: [A1], response: "done" } satisfies ChatResponse;
    expect(readPendingApprovals(body)).toEqual([A1]);
  });

  it("returns undefined when the field is absent or not an array", () => {
    expect(readPendingApprovals({ response: "done" })).toBeUndefined();
    expect(readPendingApprovals({ pendingApprovals: "nope" } as unknown as ChatResponse)).toBeUndefined();
  });
});

describe("applyApproveOutcome — pure transcript transition", () => {
  it("on ran:true drops the approval and appends the ran note to that turn only", () => {
    const turns: readonly ChatTurn[] = [
      { role: "user", text: "tell Sam I'm late" },
      assistantTurn([A1, A2])
    ];

    const next = applyApproveOutcome(turns, "a1", { ran: true, tool: "send_message" });

    expect(next[1]!.pendingApprovals).toEqual([A2]);
    expect(next[1]!.text).toContain("✅ Ran send_message.");
    // untouched turns keep identity
    expect(next[0]).toBe(turns[0]);
  });

  it("returns turns unchanged when no turn owns the id", () => {
    const turns = [assistantTurn([A1])];
    expect(applyApproveOutcome(turns, "missing", { ran: true, tool: "x" })).toEqual(turns);
  });
});

describe("applyApprove — the injectable confirm flow", () => {
  it("POSTs the approve endpoint and, on 2xx, removes the approval from the transcript", async () => {
    let capturedPath = "";
    let calls = 0;
    const post = async <T,>(path: string): Promise<T> => {
      calls += 1;
      capturedPath = path;
      return { ran: true, tool: "send_message" } as T;
    };
    let turns: readonly ChatTurn[] = [assistantTurn([A1, A2])];
    const setTurns = (update: (prev: readonly ChatTurn[]) => readonly ChatTurn[]) => {
      turns = update(turns);
    };
    const setError = vi.fn();

    await applyApprove(post, "a1", setTurns, setError);

    expect(calls).toBe(1);
    expect(capturedPath).toBe("/api/chat/approvals/a1/approve");
    expect(turns[0]!.pendingApprovals).toEqual([A2]);
    expect(turns[0]!.text).toContain("✅ Ran send_message.");
    expect(setError).not.toHaveBeenCalled();
  });

  it("on ran:false (tool errored, server kept it pending) LEAVES the card and reports it", async () => {
    const post = async <T,>(_path: string): Promise<T> => ({ ran: false, tool: "send_message" }) as T;
    const setTurns = vi.fn();
    let error: string | null = null;
    const setError = (m: string) => {
      error = m;
    };

    await applyApprove(post, "a1", setTurns, setError);

    // the card must NOT be removed — the server still has it pending for a retry
    expect(setTurns).not.toHaveBeenCalled();
    expect(error).toContain("still pending");
  });

  it("on a thrown confirm (404/403/409/network) surfaces the message and LEAVES the approval", async () => {
    const post = async <T,>(_path: string): Promise<T> => {
      throw new Error("404 Not Found: unknown or expired approval");
    };
    const before: readonly ChatTurn[] = [assistantTurn([A1])];
    const setTurns = vi.fn();
    let error: string | null = null;
    const setError = (m: string) => {
      error = m;
    };

    await applyApprove(post, "a1", setTurns, setError);

    expect(error).toContain("404");
    // the transcript is never mutated: the approval stays for a retry
    expect(setTurns).not.toHaveBeenCalled();
    expect(before[0]!.pendingApprovals).toEqual([A1]);
  });
});
