import type { ModelToolCall } from "@muse/model";
import type { AgentTask } from "@muse/multi-agent";
import { describe, expect, it } from "vitest";

import { boardStaleMs, boardTaskPrompt, formatTaskDetail, boardToolApprovalGate, formatBoard, selectObjectiveSpecsToSeed, taskNeedsReview } from "./commands-board.js";

const t = (over: Partial<AgentTask> & { id: string; title: string }): AgentTask => ({
  createdAt: "t0", dependsOn: [], runs: [], status: "todo", updatedAt: "t0", ...over
});

describe("muse board — pure surface helpers (S4)", () => {
  describe("taskNeedsReview — outbound work is draft-first (never auto-run)", () => {
    it.each(["send an email to mina", "reply to the thread", "post the update", "DM the team", "book the table", "submit the form"])(
      "outbound title needs review: %s", (title) => expect(taskNeedsReview(title)).toBe(true)
    );
    it.each(["research the topic", "summarize my notes", "draft a plan", "compute the totals"])(
      "non-outbound title runs directly: %s", (title) => expect(taskNeedsReview(title)).toBe(false)
    );
  });

  describe("formatBoard", () => {
    it("empty board prompts the user to add work", () => {
      expect(formatBoard([])).toContain("muse board add");
    });
    it("groups tasks by column and shows dependencies + block reasons", () => {
      const out = formatBoard([
        t({ id: "aaaaaaaa1", title: "first" }),
        t({ dependsOn: ["aaaaaaaa1"], id: "bbbbbbbb2", status: "blocked", blockedReason: "rate limit", title: "second" }),
        t({ id: "cccccccc3", status: "review", title: "send email" })
      ]);
      expect(out).toContain("TODO (1)");
      expect(out).toContain("BLOCKED (1)");
      expect(out).toContain("REVIEW (1)");
      expect(out).toContain("⟵ aaaaaaaa1"); // dependency shown
      expect(out).toContain("rate limit");  // block reason shown
    });
  });
});

describe("boardToolApprovalGate — fail-closed during unattended board execution (follow-up #1)", () => {
  const call = { arguments: {}, id: "c1", name: "x" } as ModelToolCall;
  it("a READ tool is allowed (the agent can search/look things up)", async () => {
    expect((await boardToolApprovalGate({ risk: "read", runId: "r", toolCall: call })).allowed).toBe(true);
  });
  it.each(["write", "execute"] as const)("a %s tool is DENIED — no autonomous send/modify on the board", async (risk) => {
    const decision = await boardToolApprovalGate({ risk, runId: "r", toolCall: call });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/review column/u);
  });
  it("egressBlocked: a READ tool with a runtime egress deny is NOT auto-allowed on an unattended board run", async () => {
    const decision = await boardToolApprovalGate({
      egressBlocked: true,
      egressWarning: "URL was not observed anywhere this run — looks model-composed",
      risk: "read",
      runId: "r",
      toolCall: call
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("egress denied");
  });
});

describe("selectObjectiveSpecsToSeed — standing-objective → board seeding (follow-up #3)", () => {
  const objs = [
    { spec: "watch the build until green", status: "active" },
    { spec: "already on board", status: "active" },
    { spec: "finished goal", status: "done" },
    { spec: "abandoned goal", status: "cancelled" },
    { spec: "   ", status: "active" }
  ];
  it("seeds only ACTIVE objectives not already on the board (deduped by title); skips done/cancelled/blank", () => {
    const out = selectObjectiveSpecsToSeed(objs, new Set(["already on board"]));
    expect(out).toEqual(["watch the build until green"]);
  });
  it("re-seeding is idempotent — once seeded, an objective isn't seeded again", () => {
    const first = selectObjectiveSpecsToSeed(objs, new Set(["already on board"]));
    const existingAfter = new Set(["already on board", ...first]);
    expect(selectObjectiveSpecsToSeed(objs, existingAfter)).toEqual([]);
  });
});

describe("boardTaskPrompt — synthesis / retry / plain prompt (#3)", () => {
  it("dependencyOutputs → a synthesis prompt that combines the sub-results for the goal", () => {
    const p = boardTaskPrompt("compare A and B", { dependencyOutputs: ["A is fast", "B is safe"] });
    expect(p).toMatch(/Combine these sub-task results/u);
    expect(p).toContain("compare A and B");
    expect(p).toContain("A is fast");
    expect(p).toContain("B is safe");
  });
  it("retryReason (no deps) → a retry prompt; plain goal otherwise", () => {
    expect(boardTaskPrompt("do X", { retryReason: "timeout" })).toMatch(/previous attempt failed: timeout/u);
    expect(boardTaskPrompt("do X", {})).toBe("do X");
  });
  it("dependencyOutputs takes precedence over retryReason (a synthesis re-run still synthesizes)", () => {
    expect(boardTaskPrompt("g", { dependencyOutputs: ["r1", "r2"], retryReason: "x" })).toMatch(/Combine these/u);
  });
});

describe("boardStaleMs — zombie staleness threshold", () => {
  it("defaults to 30 minutes", () => { expect(boardStaleMs({})).toBe(30 * 60 * 1000); });
  it("honors a positive MUSE_BOARD_STALE_MS override", () => { expect(boardStaleMs({ MUSE_BOARD_STALE_MS: "60000" })).toBe(60000); });
  it("ignores a non-numeric / non-positive override → default", () => {
    expect(boardStaleMs({ MUSE_BOARD_STALE_MS: "nope" })).toBe(30 * 60 * 1000);
    expect(boardStaleMs({ MUSE_BOARD_STALE_MS: "-5" })).toBe(30 * 60 * 1000);
  });
});

describe("formatTaskDetail — board show <id>", () => {
  it("renders status, deps, run history and the result (a container's synthesis)", () => {
    const d = formatTaskDetail(t({ id: "c1", title: "compare A B", status: "done", decomposed: true, synthesize: true, dependsOn: ["s1", "s2"], result: "A wins on speed", runs: [{ at: "t1", status: "completed", output: "A wins on speed" }] }));
    expect(d).toContain("container, synthesis");
    expect(d).toContain("depends on: s1, s2");
    expect(d).toContain("result:");
    expect(d).toContain("A wins on speed");
  });
  it("shows a blocked reason when present", () => {
    expect(formatTaskDetail(t({ id: "z", title: "x", status: "blocked", blockedReason: "crashed" }))).toContain("blocked: crashed");
  });
});
