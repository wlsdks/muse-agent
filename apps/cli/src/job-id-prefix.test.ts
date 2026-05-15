import { describe, expect, it } from "vitest";

import { resolveJobIdByPrefix } from "./job-id-prefix.js";

const sample = [
  "job_2026-05-15T15-12-30_a1b2c3d4",
  "job_2026-05-15T15-12-30_a1b29999",
  "job_2026-05-15T16-00-00_99aabbcc",
  "job_2026-05-14T09-30-00_deadbeef"
];

describe("resolveJobIdByPrefix", () => {
  it("returns 'exact' when the input matches a full job id", () => {
    expect(resolveJobIdByPrefix(sample[0]!, sample)).toEqual({
      id: sample[0],
      kind: "exact"
    });
  });

  it("returns 'prefix' when exactly one id starts with the input", () => {
    expect(resolveJobIdByPrefix("job_2026-05-15T16", sample)).toEqual({
      id: sample[2],
      kind: "prefix"
    });
  });

  it("returns 'ambiguous' with all candidates when the prefix matches > 1 id", () => {
    const result = resolveJobIdByPrefix("job_2026-05-15T15-12-30_a1b2", sample);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect([...result.matches].sort()).toEqual([sample[1]!, sample[0]!].sort());
    }
  });

  it("returns 'none' for an empty input or no prefix match", () => {
    expect(resolveJobIdByPrefix("", sample)).toEqual({ kind: "none" });
    expect(resolveJobIdByPrefix("   ", sample)).toEqual({ kind: "none" });
    expect(resolveJobIdByPrefix("nothing-like-a-job-id", sample)).toEqual({ kind: "none" });
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(resolveJobIdByPrefix(`  ${sample[3]}  `, sample)).toEqual({
      id: sample[3],
      kind: "exact"
    });
  });

  it("treats exact-match as 'exact' even when other ids would also prefix-match", () => {
    const ids = ["foo", "foobar"];
    expect(resolveJobIdByPrefix("foo", ids)).toEqual({ id: "foo", kind: "exact" });
  });
});
