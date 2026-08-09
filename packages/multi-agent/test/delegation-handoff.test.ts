import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import {
  assessDelegationFanout,
  bindDelegationSubtaskScope,
  consumeDelegationHandoffLease,
  createDelegationHandoffLease,
  inspectDelegationHandoffLease,
  type DelegationHandoff
} from "../src/delegation-handoff.js";

const NOW = "2026-07-29T00:00:00.000Z";
const WORKSPACE_ROOT = resolve(process.cwd(), "workspace", "muse");
const FIRST_REPORT_ROOT = resolve(WORKSPACE_ROOT, "reports", "a");

const handoff = (over: Partial<DelegationHandoff> = {}): DelegationHandoff => ({
  contextIndependent: true,
  decomposition: "fanout",
  mergeable: true,
  objective: "Compare two independent implementations",
  schemaVersion: 1,
  sharedState: false,
  subtasks: [
    {
      allowedToolNames: ["file_read"],
      dependsOn: [],
      effectScopes: [],
      expiresAt: "2026-07-30T00:00:00.000Z",
      id: "s1",
      input: "Inspect implementation A",
      outputSchema: "plain-text findings",
      role: "reader",
      writablePaths: ["reports/a"]
    },
    {
      allowedToolNames: ["file_read"],
      dependsOn: [],
      effectScopes: [],
      expiresAt: "2026-07-30T00:00:00.000Z",
      id: "s2",
      input: "Inspect implementation B",
      outputSchema: "plain-text findings",
      role: "reader",
      writablePaths: ["reports/b"]
    }
  ],
  ...over
});

describe("delegation handoff fan-out admission", () => {
  it("accepts and deeply freezes a disjoint, read-only, context-independent handoff", () => {
    const decision = assessDelegationFanout(handoff(), ["s1", "s2"], NOW);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(Object.isFrozen(decision.handoff)).toBe(true);
    expect(Object.isFrozen(decision.handoff.subtasks)).toBe(true);
    expect(Object.isFrozen(decision.handoff.subtasks[0]!.writablePaths)).toBe(true);
  });

  it.each([
    ["shared state", { sharedState: true }],
    ["context dependency", { contextIndependent: false }],
    ["non-mergeable output", { mergeable: false }]
  ])("rejects %s", (_label, over) => {
    expect(assessDelegationFanout(handoff(over), ["s1", "s2"], NOW)).toMatchObject({ ok: false });
  });

  it("rejects ordered dependencies and declared effects", () => {
    const ordered = handoff({ subtasks: [
      handoff().subtasks[0]!,
      { ...handoff().subtasks[1]!, dependsOn: ["s1"] }
    ] });
    expect(assessDelegationFanout(ordered, ["s1", "s2"], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("ordered") });

    const effectful = handoff({ subtasks: [
      { ...handoff().subtasks[0]!, effectScopes: ["external-send"] },
      handoff().subtasks[1]!
    ] });
    expect(assessDelegationFanout(effectful, ["s1", "s2"], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("effects") });
  });

  it("rejects equal, ancestor, or malformed writable paths", () => {
    const overlap = handoff({ subtasks: [
      { ...handoff().subtasks[0]!, writablePaths: ["reports"] },
      { ...handoff().subtasks[1]!, writablePaths: ["reports/b"] }
    ] });
    expect(assessDelegationFanout(overlap, ["s1", "s2"], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("overlaps") });

    const caseAlias = handoff({ subtasks: [
      { ...handoff().subtasks[0]!, writablePaths: ["Reports/A"] },
      { ...handoff().subtasks[1]!, writablePaths: ["reports/a"] }
    ] });
    expect(assessDelegationFanout(caseAlias, ["s1", "s2"], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("overlaps") });

    const traversal = handoff({ subtasks: [
      { ...handoff().subtasks[0]!, writablePaths: ["../outside"] },
      handoff().subtasks[1]!
    ] });
    expect(assessDelegationFanout(traversal, ["s1", "s2"], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("workspace-relative") });

    for (const path of ["reports/a:stream", "reports/CON", "reports/file?.txt"]) {
      const windowsAlias = handoff({ subtasks: [
        { ...handoff().subtasks[0]!, writablePaths: [path] },
        handoff().subtasks[1]!
      ] });
      expect(assessDelegationFanout(windowsAlias, ["s1", "s2"], NOW)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("workspace-relative")
      });
    }
  });

  it("rejects missing fields, expired scopes, and subtask mismatch", () => {
    const missing = { ...handoff(), objective: undefined };
    expect(assessDelegationFanout(missing, ["s1", "s2"], NOW)).toMatchObject({ ok: false });

    const expired = handoff({ subtasks: [
      { ...handoff().subtasks[0]!, expiresAt: NOW },
      handoff().subtasks[1]!
    ] });
    expect(assessDelegationFanout(expired, ["s1", "s2"], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    expect(assessDelegationFanout(handoff(), ["s2", "s1"], NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("exactly match") });
  });

  it("rejects non-canonical, local-zone, and overflow timestamps", () => {
    for (const expiresAt of [
      "2026-07-30",
      "2026-07-30T00:00:00",
      "2026-07-30T00:00:00+09:00",
      "2026-02-30T00:00:00.000Z"
    ]) {
      const invalid = handoff({ subtasks: [
        { ...handoff().subtasks[0]!, expiresAt },
        handoff().subtasks[1]!
      ] });
      expect(assessDelegationFanout(invalid, ["s1", "s2"], NOW)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("canonical UTC")
      });
    }
    expect(assessDelegationFanout(handoff(), ["s1", "s2"], "2026-07-29")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("canonical UTC")
    });
  });

  it("binds one admitted subtask to frozen absolute workspace paths", () => {
    const scope = bindDelegationSubtaskScope(handoff(), "s1", WORKSPACE_ROOT, NOW);
    expect(scope).toEqual({
      allowedToolNames: ["file_read"],
      expiresAt: "2026-07-30T00:00:00.000Z",
      writablePaths: [FIRST_REPORT_ROOT]
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.writablePaths)).toBe(true);
    expect(() => bindDelegationSubtaskScope(handoff(), "ghost", WORKSPACE_ROOT, NOW)).toThrow(/no subtask/u);
    expect(() => bindDelegationSubtaskScope(handoff(), "s1", "relative", NOW)).toThrow(/absolute/u);
  });

  it("issues an opaque one-shot lease that rejects spoofing and replay", () => {
    const future = handoff({
      subtasks: handoff().subtasks.map((subtask) => ({
        ...subtask,
        expiresAt: "2099-07-30T00:00:00.000Z"
      }))
    });
    const lease = createDelegationHandoffLease(future, "s1", WORKSPACE_ROOT, NOW);

    expect(inspectDelegationHandoffLease(lease)).toEqual({
      allowedToolNames: ["file_read"],
      expiresAt: "2099-07-30T00:00:00.000Z",
      writablePaths: [FIRST_REPORT_ROOT]
    });
    for (const forged of [{}, { ...lease }, JSON.parse(JSON.stringify(lease)) as unknown]) {
      expect(() => consumeDelegationHandoffLease(forged)).toThrow(/invalid or forged/u);
    }

    expect(consumeDelegationHandoffLease(lease)).toEqual({
      allowedToolNames: ["file_read"],
      expiresAt: "2099-07-30T00:00:00.000Z",
      writablePaths: [FIRST_REPORT_ROOT]
    });
    expect(() => consumeDelegationHandoffLease(lease)).toThrow(/already consumed/u);
  });

  it("rejects a lease that expires after admission without consuming another lease", () => {
    const future = handoff({
      subtasks: handoff().subtasks.map((subtask) => ({
        ...subtask,
        expiresAt: "2099-07-30T00:00:00.000Z"
      }))
    });
    const expired = createDelegationHandoffLease(future, "s1", WORKSPACE_ROOT, NOW);
    const live = createDelegationHandoffLease(future, "s2", WORKSPACE_ROOT, NOW);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2099-07-30T00:00:00.000Z"));
      expect(() => consumeDelegationHandoffLease(expired)).toThrow(/expired/u);
    } finally {
      vi.useRealTimers();
    }
    expect(() => consumeDelegationHandoffLease(live)).not.toThrow();
  });
});
