import { describe, expect, it } from "vitest";

import {
  clampPreview,
  dryRunUrl,
  executionsUrl,
  humanizeDurationMs,
  resolveExecutionDisplay,
  statusTone
} from "./flow-executions-compile.js";

describe("resolveExecutionDisplay", () => {
  const base = { result: null, resultPreview: null, failureReason: null } as const;

  it("shows a FAILED run's clean failureReason as an error (not the raw prefixed result)", () => {
    const display = resolveExecutionDisplay({
      ...base,
      status: "FAILED",
      result: "Job 'X' failed: MCP server 'muse.messaging' is not connected",
      failureReason: "MCP server 'muse.messaging' is not connected"
    });
    expect(display).toEqual({ text: "MCP server 'muse.messaging' is not connected", tone: "error" });
  });

  it("falls back to the raw result for a FAILED run with no extractable reason", () => {
    const display = resolveExecutionDisplay({
      ...base,
      status: "FAILED",
      result: "something went wrong",
      failureReason: null
    });
    expect(display).toEqual({ text: "something went wrong", tone: "output" });
  });

  it("treats a blank/whitespace failureReason as absent", () => {
    const display = resolveExecutionDisplay({ ...base, status: "FAILED", result: "raw", failureReason: "   " });
    expect(display).toEqual({ text: "raw", tone: "output" });
  });

  it("shows a SUCCESS run's result as plain output, never as an error", () => {
    const display = resolveExecutionDisplay({
      ...base,
      status: "SUCCESS",
      result: "2026-07-18T00:00:00Z",
      failureReason: null
    });
    expect(display).toEqual({ text: "2026-07-18T00:00:00Z", tone: "output" });
  });

  it("never styles a non-FAILED status as an error even if a stray failureReason is present", () => {
    const display = resolveExecutionDisplay({
      ...base,
      status: "SUCCESS",
      result: "ok",
      failureReason: "leftover"
    });
    expect(display.tone).toBe("output");
  });

  it("returns empty output text when a run has no result at all", () => {
    expect(resolveExecutionDisplay({ ...base, status: "RUNNING" })).toEqual({ text: "", tone: "output" });
  });
});

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
