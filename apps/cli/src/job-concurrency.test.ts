import { describe, expect, it } from "vitest";

import { jobConcurrencyRefusal, resolveJobsMaxConcurrent } from "./job-concurrency.js";

describe("resolveJobsMaxConcurrent", () => {
  it("defaults to 3 when MUSE_JOBS_MAX_CONCURRENT is absent", () => {
    expect(resolveJobsMaxConcurrent({})).toBe(3);
  });

  it("uses a genuine positive integer override", () => {
    expect(resolveJobsMaxConcurrent({ MUSE_JOBS_MAX_CONCURRENT: "5" })).toBe(5);
    expect(resolveJobsMaxConcurrent({ MUSE_JOBS_MAX_CONCURRENT: "2" })).toBe(2);
  });

  it("floors 0 to the default instead of forbidding all jobs", () => {
    expect(resolveJobsMaxConcurrent({ MUSE_JOBS_MAX_CONCURRENT: "0" })).toBe(3);
  });

  it("falls back to the default for a negative value", () => {
    expect(resolveJobsMaxConcurrent({ MUSE_JOBS_MAX_CONCURRENT: "-1" })).toBe(3);
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(resolveJobsMaxConcurrent({ MUSE_JOBS_MAX_CONCURRENT: "abc" })).toBe(3);
  });
});

describe("jobConcurrencyRefusal", () => {
  it("allows a new job when running count is under the cap", () => {
    expect(jobConcurrencyRefusal(2, 3)).toBeUndefined();
    expect(jobConcurrencyRefusal(0, 3)).toBeUndefined();
  });

  it("refuses at the cap, naming the running count and the limit", () => {
    const refusal = jobConcurrencyRefusal(3, 3);
    expect(refusal).toContain("3");
    expect(refusal).toMatch(/limit/iu);
  });

  it("refuses over the cap too", () => {
    const refusal = jobConcurrencyRefusal(4, 3);
    expect(refusal).toBeDefined();
    expect(refusal).toContain("4");
  });
});
