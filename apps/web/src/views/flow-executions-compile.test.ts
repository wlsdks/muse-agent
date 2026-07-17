import { describe, expect, it } from "vitest";

import {
  clampPreview,
  dryRunUrl,
  executionsUrl,
  humanizeDurationMs,
  statusTone
} from "./flow-executions-compile.js";

describe("executionsUrl / dryRunUrl", () => {
  it("builds the exact GET executions url with the default limit", () => {
    expect(executionsUrl("job_1")).toBe("/api/scheduler/jobs/job_1/executions?limit=5");
  });

  it("honors a custom limit", () => {
    expect(executionsUrl("job_1", 10)).toBe("/api/scheduler/jobs/job_1/executions?limit=10");
  });

  it("encodes a job id with special characters", () => {
    expect(executionsUrl("job/with space")).toBe("/api/scheduler/jobs/job%2Fwith%20space/executions?limit=5");
  });

  it("builds the exact POST dry-run url", () => {
    expect(dryRunUrl("job_1")).toBe("/api/scheduler/jobs/job_1/dry-run");
  });
});

describe("statusTone", () => {
  it("maps every status to its badge tone", () => {
    expect(statusTone("SUCCESS")).toBe("ok");
    expect(statusTone("FAILED")).toBe("err");
    expect(statusTone("RUNNING")).toBe("accent");
    expect(statusTone("SKIPPED")).toBe("neutral");
  });
});

describe("humanizeDurationMs", () => {
  it("formats to one decimal of seconds", () => {
    expect(humanizeDurationMs(1234)).toBe("1.2s");
    expect(humanizeDurationMs(0)).toBe("0.0s");
  });

  it("falls back to 0.0s for a non-finite/negative duration", () => {
    expect(humanizeDurationMs(Number.NaN)).toBe("0.0s");
    expect(humanizeDurationMs(-5)).toBe("0.0s");
  });
});

describe("clampPreview", () => {
  it("leaves a short text untouched and unclamped", () => {
    expect(clampPreview("short result")).toEqual({ clamped: false, text: "short result" });
  });

  it("clamps a long text at the max length with an ellipsis", () => {
    const long = "x".repeat(200);
    const result = clampPreview(long, 160);
    expect(result.clamped).toBe(true);
    expect(result.text.length).toBe(160);
    expect(result.text.endsWith("…")).toBe(true);
  });
});
