import { describe, expect, it } from "vitest";

import type { StandingObjective } from "@muse/stores";
import { summariseObjectivesRows } from "../src/personal-status-summary.js";

const obj = (userId: string, status: string, spec = "watch the build"): StandingObjective =>
  ({ id: "o", userId, status, spec, createdAt: "2026-01-01T00:00:00Z", kind: "watch" }) as StandingObjective;

describe("summariseObjectivesRows", () => {
  it("returns all-zero counts for no rows", () => {
    expect(summariseObjectivesRows([], "u1")).toEqual({ active: 0, cancelled: 0, done: 0, escalated: 0, total: 0 });
  });

  it("counts only the rows belonging to the given user (no cross-user leakage)", () => {
    expect(summariseObjectivesRows([obj("u1", "active"), obj("u2", "active"), obj("u1", "done")], "u1")).toEqual({
      active: 1,
      cancelled: 0,
      done: 1,
      escalated: 0,
      total: 2,
    });
  });

  it("buckets every status and surfaces the first escalated spec as the sample", () => {
    expect(
      summariseObjectivesRows(
        [obj("u1", "active"), obj("u1", "escalated", "E1"), obj("u1", "done"), obj("u1", "cancelled")],
        "u1",
      ),
    ).toEqual({ active: 1, cancelled: 1, done: 1, escalated: 1, total: 4, escalatedSample: "E1" });
  });

  it("keeps the first escalated sample and ignores later ones", () => {
    expect(summariseObjectivesRows([obj("u1", "escalated", "FIRST"), obj("u1", "escalated", "SECOND")], "u1")).toMatchObject({
      escalated: 2,
      escalatedSample: "FIRST",
    });
  });

  it("does not set a sample for an escalated objective with an empty spec", () => {
    expect(summariseObjectivesRows([obj("u1", "escalated", "")], "u1")).not.toHaveProperty("escalatedSample");
  });

  it("counts an unknown status in the total without incrementing any bucket", () => {
    expect(summariseObjectivesRows([obj("u1", "paused")], "u1")).toEqual({
      active: 0,
      cancelled: 0,
      done: 0,
      escalated: 0,
      total: 1,
    });
  });

  it("skips a row whose userId is not the requested string", () => {
    expect(summariseObjectivesRows([{ id: "x", userId: 123, status: "active", spec: "s" } as unknown as StandingObjective], "u1")).toEqual({
      active: 0,
      cancelled: 0,
      done: 0,
      escalated: 0,
      total: 0,
    });
  });
});
