/**
 * Pure compile seam for the Flows builder's "실행 기록" (execution history)
 * card: exact URL construction + display-formatting helpers, no React, no
 * fetch — same "compile seam" pattern as `flow-edit-compile.ts`, unit-tested
 * for fidelity against the real server contract
 * (`GET/POST /api/scheduler/jobs/:jobId/(executions|dry-run)`,
 * `scheduler-routes.ts`).
 */

import type { ScheduledJobExecutionStatus } from "../api/types.js";

export const EXECUTIONS_DEFAULT_LIMIT = 5;
export const EXECUTION_PREVIEW_MAX_LENGTH = 160;

export function executionsUrl(jobId: string, limit: number = EXECUTIONS_DEFAULT_LIMIT): string {
  return `/api/scheduler/jobs/${encodeURIComponent(jobId)}/executions?limit=${limit.toString()}`;
}

export function dryRunUrl(jobId: string): string {
  return `/api/scheduler/jobs/${encodeURIComponent(jobId)}/dry-run`;
}

export type StatusTone = "ok" | "err" | "accent" | "neutral";

export function statusTone(status: ScheduledJobExecutionStatus): StatusTone {
  switch (status) {
    case "SUCCESS":
      return "ok";
    case "FAILED":
      return "err";
    case "RUNNING":
      return "accent";
    default:
      return "neutral";
  }
}

/** Matches the `(ms / 1000).toFixed(1)}s` convention already used for
 * durations elsewhere (`Agents.tsx`'s orchestration history). */
export function humanizeDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0.0s";
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export interface ExecutionDisplay {
  readonly tone: "error" | "output";
  readonly text: string;
}

/**
 * What an execution row should SHOW as its body. A FAILED run surfaces its
 * clean `failureReason` (the reason the server extracted, without the
 * redundant "Job 'X' failed:" prefix the FAILED badge already conveys) as an
 * ERROR — so a failure reads as a failure instead of the same muted text a
 * success output gets, and the already-computed `failureReason` stops being
 * dead data on the wire. Every other status (and a FAILED run with no
 * extractable reason) shows the run's result/preview as plain output.
 */
export function resolveExecutionDisplay(execution: {
  readonly status: ScheduledJobExecutionStatus;
  readonly result: string | null;
  readonly resultPreview: string | null;
  readonly failureReason: string | null;
}): ExecutionDisplay {
  if (execution.status === "FAILED") {
    const reason = execution.failureReason?.trim();
    if (reason && reason.length > 0) {
      return { text: reason, tone: "error" };
    }
  }
  return { text: execution.result ?? execution.resultPreview ?? "", tone: "output" };
}

export interface ClampedPreview {
  readonly text: string;
  readonly clamped: boolean;
}

/** Clamps a result preview to `maxLength`, reporting whether it was clamped
 * so the row can offer a 더보기 expand toggle only when there's more to show. */
export function clampPreview(text: string, maxLength: number = EXECUTION_PREVIEW_MAX_LENGTH): ClampedPreview {
  if (text.length <= maxLength) {
    return { clamped: false, text };
  }
  return { clamped: true, text: `${text.slice(0, maxLength - 1).trimEnd()}…` };
}
