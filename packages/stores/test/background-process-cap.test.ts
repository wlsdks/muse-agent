import { describe, expect, it } from "vitest";

import { capBackgroundProcesses, type BackgroundProcessRecord } from "../src/index.js";

const term = (id: string, endedAt: string): BackgroundProcessRecord => ({
  id, pid: 1, command: "x", startedAt: "2026-06-01T00:00:00.000Z", status: "exited", exitCode: 0, endedAt
});
const run = (id: string): BackgroundProcessRecord => ({
  id, pid: 1, command: "x", startedAt: "2026-06-01T00:00:00.000Z", status: "running"
});

describe("capBackgroundProcesses (X-3 registry self-bound)", () => {
  it("leaves the list unchanged when terminal count is within the cap", () => {
    const records = [run("a"), term("b", "2026-06-02T00:00:00.000Z")];
    expect(capBackgroundProcesses(records, 50)).toBe(records);
  });

  it("drops the OLDEST terminal records beyond the cap, keeping the newest", () => {
    const records = [
      term("old", "2026-06-01T00:00:00.000Z"),
      term("mid", "2026-06-02T00:00:00.000Z"),
      term("new", "2026-06-03T00:00:00.000Z")
    ];
    const out = capBackgroundProcesses(records, 2).map((r) => r.id);
    expect(out).toEqual(["mid", "new"]); // 'old' dropped, order preserved
  });

  it("NEVER drops running records even when over the cap", () => {
    const records = [run("r1"), term("t1", "2026-06-01T00:00:00.000Z"), run("r2"), term("t2", "2026-06-02T00:00:00.000Z")];
    const out = capBackgroundProcesses(records, 1).map((r) => r.id);
    expect(out).toContain("r1");
    expect(out).toContain("r2");
    expect(out).toContain("t2"); // newest terminal kept
    expect(out).not.toContain("t1"); // oldest terminal dropped
  });
});
