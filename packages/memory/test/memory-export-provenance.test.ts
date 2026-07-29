import { describe, expect, it } from "vitest";

import {
  exactUserMemoryId,
  projectMemoryExportProvenanceCompleteness,
  type BeliefProvenance,
  type ExactUserMemoryEntry
} from "../src/index.js";

const USER = "owner";
const EXACT = exactUserMemoryId(USER, "fact", "home_city");
const target = (version: number, value = "Seoul"): ExactUserMemoryEntry => ({
  exactId: EXACT,
  key: "home_city",
  kind: "fact",
  value,
  version
});
const assertion = (over: Partial<BeliefProvenance> = {}): BeliefProvenance => ({
  key: "home_city",
  kind: "fact",
  learnedAt: "2026-01-01T00:00:00.000Z",
  source: "user",
  userId: USER,
  value: "Seoul",
  ...over
});

describe("projectMemoryExportProvenanceCompleteness", () => {
  it("links initial, kept, and invalidated versions without inventing history", () => {
    const report = projectMemoryExportProvenanceCompleteness(USER, [target(2)], [
      assertion(),
      assertion({
        learnedAt: "2026-02-01T00:00:00.000Z",
        ownerResolution: {
          action: "keep",
          exactId: EXACT,
          expectedVersion: 1,
          requestId: "keep-home-city-v1"
        }
      }),
      assertion({
        invalidation: true,
        learnedAt: "2026-03-01T00:00:00.000Z",
        ownerResolution: {
          action: "invalidate",
          exactId: EXACT,
          expectedVersion: 2,
          requestId: "invalidate-home-city-v2"
        },
        value: ""
      })
    ]);

    expect(report.complete).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.links.map(({ state, version }) => ({ state, version }))).toEqual([
      { state: "historical", version: 1 },
      { state: "historical", version: 2 },
      { state: "invalidated", version: 2 }
    ]);
  });

  it("marks an unversioned later correction and current target incomplete", () => {
    const report = projectMemoryExportProvenanceCompleteness(USER, [target(2, "Busan")], [
      assertion(),
      assertion({ learnedAt: "2026-02-01T00:00:00.000Z", value: "Busan" })
    ]);

    expect(report.complete).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-version-link" }),
      expect.objectContaining({ code: "missing-current-link", exactId: EXACT })
    ]));
  });

  it("marks a plain forget retraction incomplete instead of guessing its version", () => {
    const report = projectMemoryExportProvenanceCompleteness(USER, [], [
      assertion(),
      assertion({ learnedAt: "2026-02-01T00:00:00.000Z", retraction: true, value: "" })
    ]);

    expect(report.complete).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "missing-version-link" }));
    expect(report.links).toHaveLength(1);
  });

  it("does not restart version numbering at v1 after an unversioned retraction", () => {
    const report = projectMemoryExportProvenanceCompleteness(USER, [target(2, "Busan")], [
      assertion({ learnedAt: "2026-01-01T00:00:00.000Z", retraction: true, value: "" }),
      assertion({ learnedAt: "2026-02-01T00:00:00.000Z", value: "Busan" })
    ]);

    expect(report.complete).toBe(false);
    expect(report.links).toEqual([]);
    expect(report.issues.filter((issue) => issue.code === "missing-version-link")).toHaveLength(2);
  });

  it("fails closed when the current version is simultaneously kept and invalidated", () => {
    const keep = assertion({
      learnedAt: "2026-03-01T00:00:00.000Z",
      ownerResolution: {
        action: "keep",
        exactId: EXACT,
        expectedVersion: 1,
        requestId: "keep-home-city-v1"
      }
    });
    const invalidation = assertion({
      invalidation: true,
      learnedAt: "2026-03-01T00:00:00.000Z",
      ownerResolution: {
        action: "invalidate",
        exactId: EXACT,
        expectedVersion: 2,
        requestId: "invalidate-home-city-v2"
      },
      value: ""
    });
    const forward = projectMemoryExportProvenanceCompleteness(
      USER,
      [target(2)],
      [assertion(), keep, invalidation]
    );
    const reverse = projectMemoryExportProvenanceCompleteness(
      USER,
      [target(2)],
      [invalidation, keep, assertion()]
    );

    expect(forward).toEqual(reverse);
    expect(forward.complete).toBe(false);
    expect(forward.issues).toContainEqual(expect.objectContaining({
      code: "ambiguous-current-link",
      exactId: EXACT
    }));
  });

  it("fails closed for malformed targets and is deterministic under input permutation", () => {
    const malformed = { ...target(1), exactId: "home_city" };
    expect(projectMemoryExportProvenanceCompleteness(USER, [malformed], [assertion()]))
      .toMatchObject({ complete: false, issues: [{ code: "malformed-history" }] });

    const entries = [
      assertion(),
      assertion({
        learnedAt: "2026-02-01T00:00:00.000Z",
        ownerResolution: {
          action: "keep",
          exactId: EXACT,
          expectedVersion: 1,
          requestId: "keep-home-city-v1"
        }
      })
    ];
    expect(projectMemoryExportProvenanceCompleteness(USER, [target(2)], entries))
      .toEqual(projectMemoryExportProvenanceCompleteness(USER, [target(2)], [...entries].reverse()));
  });
});
