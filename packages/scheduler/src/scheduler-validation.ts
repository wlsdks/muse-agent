/**
 * Input validation for scheduled jobs — timezone, cron expression, job name,
 * execution timeout, retry config, and per-job-type required fields. Each throws
 * a SchedulerValidationError on invalid input (fail-closed). Split out of
 * scheduler-helpers.ts so the validation rules and the job-normalization /
 * row-mapping logic have separate homes.
 */

import { CronExpressionParser } from "cron-parser";

import { SchedulerValidationError } from "./scheduler-errors.js";
import type { ScheduledJob, ScheduledJobInput, ScheduledJobType } from "./index.js";

export const maxRetryCountCeiling = 100;
const minExecutionTimeoutMs = 1_000;
const maxExecutionTimeoutMs = 3_600_000;

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new SchedulerValidationError(`Invalid timezone: ${timezone}`);
  }
}

export function validateCronExpression(cron: string): void {
  const trimmed = cron.trim();

  // Nickname macros (`@daily`, `@hourly`, …) are a single token,
  // not 5/6 fields — the field-count gate only makes sense for
  // standard numeric expressions. Defer macros wholly to the
  // parser so validation matches computeNextRunAt exactly (it
  // accepts the macros this parser supports and rejects the ones
  // it doesn't, e.g. `@every` in the pinned version).
  if (!trimmed.startsWith("@")) {
    const fields = trimmed.split(/\s+/u);
    if (fields.length !== 5 && fields.length !== 6) {
      throw new SchedulerValidationError(`Invalid cron expression: ${cron}`);
    }
  }

  try {
    CronExpressionParser.parse(cron);
  } catch {
    throw new SchedulerValidationError(`Invalid cron expression: ${cron}`);
  }
}

export function validateJobName(name: string): void {
  if (name.trim().length === 0) {
    throw new SchedulerValidationError("Scheduled job name must not be blank");
  }
}

export function validateExecutionTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined || timeoutMs === 0) {
    return;
  }

  // NaN/Infinity slip past raw `<` / `>` comparisons (they return
  // false against any number), so the range check below would let
  // a non-finite timeout through to `resolveJobTimeout`'s runtime
  // guard. The validate gate is the contract; non-finite is
  // invalid input here, not "in range".
  if (!Number.isFinite(timeoutMs) || timeoutMs < minExecutionTimeoutMs || timeoutMs > maxExecutionTimeoutMs) {
    throw new SchedulerValidationError(
      `executionTimeoutMs must be 0 or between ${minExecutionTimeoutMs} and ${maxExecutionTimeoutMs}`
    );
  }
}

export function validateRetryConfig(retryOnFailure: boolean, maxRetryCount: number): void {
  if (!retryOnFailure) {
    return;
  }
  // NaN < 1 / NaN > N both return false, so without the integer
  // guard a non-finite maxRetryCount slips past the bound check.
  // The upper ceiling stops a `maxRetryCount: 1_000_000` config
  // from turning `runWithRetry` into a retry-storm against the
  // job's target (LLM / MCP tool / HTTP) — sibling of the
  // executionTimeout's two-sided bound.
  if (!Number.isInteger(maxRetryCount) || maxRetryCount < 1 || maxRetryCount > maxRetryCountCeiling) {
    throw new SchedulerValidationError(
      `maxRetryCount must be an integer between 1 and ${maxRetryCountCeiling.toString()} when retryOnFailure is enabled`
    );
  }
}

export function validateJobTypeFields(jobType: ScheduledJobType, job: ScheduledJobInput | ScheduledJob): void {
  if (jobType === "mcp_tool") {
    requireText(job.mcpServerName, "MCP tool jobs require mcpServerName");
    requireText(job.toolName, "MCP tool jobs require toolName");
    return;
  }

  requireText(job.agentPrompt, "Agent jobs require agentPrompt");
}

export function requireText(value: string | null | undefined, message: string): string {
  const text = value?.trim();

  if (!text) {
    throw new SchedulerValidationError(message);
  }

  return text;
}

