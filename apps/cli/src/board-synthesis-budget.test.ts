import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { budgetAndSpillOutputs, budgetChildOutput, formatSpillNote, perChildSynthesisBudget, SYNTHESIS_PER_CHILD_FLOOR } from "./board-synthesis-budget.js";

describe("perChildSynthesisBudget — headroom split across children, floored", () => {
  it("splits headroom * 0.5 across children when above the floor", () => {
    expect(perChildSynthesisBudget(24000, 3)).toBe(4000);
  });
  it("floors at SYNTHESIS_PER_CHILD_FLOOR when the per-child share is smaller", () => {
    expect(perChildSynthesisBudget(24000, 12)).toBe(SYNTHESIS_PER_CHILD_FLOOR);
  });
  it("childCount <= 0 returns the floor (no divide-by-zero)", () => {
    expect(perChildSynthesisBudget(24000, 0)).toBe(SYNTHESIS_PER_CHILD_FLOOR);
    expect(perChildSynthesisBudget(24000, -1)).toBe(SYNTHESIS_PER_CHILD_FLOOR);
  });
  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("non-finite/non-positive headroom %s returns the floor", (headroom) => {
    expect(perChildSynthesisBudget(headroom, 3)).toBe(SYNTHESIS_PER_CHILD_FLOOR);
  });
  it("result is always an integer >= the floor", () => {
    for (const [headroom, count] of [[24000, 3], [24000, 12], [100000, 7], [1, 1]] as const) {
      const b = perChildSynthesisBudget(headroom, count);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(SYNTHESIS_PER_CHILD_FLOOR);
    }
  });
});

describe("budgetChildOutput — under/over budget", () => {
  it("under budget keeps the output verbatim, no overflow", () => {
    const out = "short output";
    const result = budgetChildOutput(out, 100);
    expect(result.kept).toBe(out);
    expect(result.overflow).toBe(false);
  });
  it("over budget truncates to exactly the budget and flags overflow", () => {
    const out = "x".repeat(5000);
    const result = budgetChildOutput(out, 2000);
    expect(result.kept.length).toBe(2000);
    expect(result.kept).toBe(out.slice(0, 2000));
    expect(result.overflow).toBe(true);
  });
});

describe("budgetAndSpillOutputs — behavioral round-trip", () => {
  it("a small output passes through untouched, no spill recorded", () => {
    const writes: { path: string; content: string }[] = [];
    const result = budgetAndSpillOutputs(["a small answer"], {
      headroom: 24000,
      makeName: (i) => `t-${i.toString()}.txt`,
      spillDir: "/tmp/board-spill-test",
      writeSpill: (path, content) => writes.push({ content, path })
    });
    expect(result.segments).toEqual(["a small answer"]);
    expect(result.spills).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("a large output is truncated in the segment AND spilled with the full original content, path referenced", () => {
    const large = "y".repeat(20000);
    const writes: { path: string; content: string }[] = [];
    const result = budgetAndSpillOutputs([large], {
      headroom: 24000,
      makeName: (i) => `t-${i.toString()}.txt`,
      spillDir: "/tmp/board-spill-test",
      writeSpill: (path, content) => writes.push({ content, path })
    });
    const expectedPath = join("/tmp/board-spill-test", "t-0.txt");
    expect(result.segments[0]?.length).toBeLessThan(large.length);
    expect(result.segments[0]).toContain(expectedPath);
    expect(result.spills).toEqual([{ index: 0, path: expectedPath }]);
    expect(writes).toEqual([{ content: large, path: expectedPath }]);
    // Round-trip: the spilled content equals the original, untruncated output.
    expect(writes[0]?.content).toBe(large);
  });

  it("only the overflowing children spill; small siblings pass through", () => {
    const small = "small one";
    const large = "z".repeat(10000);
    const writes: { path: string; content: string }[] = [];
    const result = budgetAndSpillOutputs([small, large, small], {
      headroom: 24000,
      makeName: (i) => `t-${i.toString()}.txt`,
      spillDir: "/tmp/board-spill-test",
      writeSpill: (path, content) => writes.push({ content, path })
    });
    expect(result.spills.map((s) => s.index)).toEqual([1]);
    expect(writes.length).toBe(1);
    expect(result.segments[0]).toBe(small);
    expect(result.segments[2]).toBe(small);
    expect(result.segments[1]).toContain(join("/tmp/board-spill-test", "t-1.txt"));
  });
});

describe("formatSpillNote — pure note text appended to the synthesis answer", () => {
  it("no spills → empty note", () => expect(formatSpillNote(0, "/tmp/x")).toBe(""));
  it("names the spill dir and count", () => {
    const note = formatSpillNote(2, "/tmp/board-spill-test");
    expect(note).toContain("2 sub-task output(s)");
    expect(note).toContain("/tmp/board-spill-test");
  });
});

describe("executor wiring (behavioral) — real temp dir, real fs writer, no model", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "muse-board-spill-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("2 oversized dependency outputs spill to real files; segments are truncated + reference the paths; the note names the spill dir", () => {
    const oversized1 = "a".repeat(20000);
    const oversized2 = "b".repeat(20000);
    const taskId = "task-123";
    const { segments, spills } = budgetAndSpillOutputs([oversized1, oversized2], {
      headroom: 24000,
      makeName: (i) => `${taskId}-${i.toString()}.txt`,
      spillDir: dir,
      writeSpill: (path, content) => { mkdirSync(dir, { recursive: true }); writeFileSync(path, content, "utf8"); }
    });

    expect(spills.length).toBe(2);
    for (const spill of spills) {
      expect(existsSync(spill.path)).toBe(true);
    }
    expect(readFileSync(join(dir, `${taskId}-0.txt`), "utf8")).toBe(oversized1);
    expect(readFileSync(join(dir, `${taskId}-1.txt`), "utf8")).toBe(oversized2);
    expect(segments[0]?.length).toBeLessThan(oversized1.length);
    expect(segments[1]?.length).toBeLessThan(oversized2.length);
    expect(segments[0]).toContain(join(dir, `${taskId}-0.txt`));
    expect(segments[1]).toContain(join(dir, `${taskId}-1.txt`));

    const note = formatSpillNote(spills.length, dir);
    expect(note).toContain(dir);
    expect(note).toContain("2 sub-task output(s)");
  });
});
