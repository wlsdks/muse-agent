import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { INJECTION_SPAN_PLACEHOLDER } from "@muse/agent-core";
import { createRunId, type JsonObject } from "@muse/shared";
import { isRecord } from "@muse/shared";

export type ParsedWorkerResult =
  | { readonly ok: true; readonly result: AgentRunResult }
  | { readonly ok: false; readonly reason: string };

/**
 * Typed validation of the worker's RESULT OBJECT at the boundary (MAST: an
 * unvalidated partial result flowing downstream is the dominant multi-agent
 * bug class). A worker whose run resolves to a malformed shape — not an
 * AgentRunResult with a string output — is treated exactly like a thrown
 * failure, never consumed.
 */
export function parseWorkerResult(value: unknown): ParsedWorkerResult {
  if (!isWorkerResult(value)) {
    return { ok: false, reason: "worker result is not an object" };
  }
  if (!value.runId || typeof value.runId !== "string" || value.runId.length === 0) {
    return { ok: false, reason: "worker result has no runId" };
  }
  return { ok: true, result: value };
}

function isWorkerResult(value: unknown): value is AgentRunResult {
  return isRecord(value)
    && isRecord(value.response)
    && typeof value.response.output === "string"
    && typeof value.runId === "string"
    && value.runId.length > 0;
}

export type WorkerHandoff =
  | { readonly ok: true; readonly workerId: string; readonly output: string }
  | { readonly ok: false; readonly workerId: string; readonly reason: string };

/**
 * Typed hand-off validation at the worker boundary. An EMPTY worker output
 * flowing downstream as "completed" is the dominant multi-agent bug class
 * (MAST: information withholding) — the next worker, the synthesizer, or the
 * caller reads silence as success. Fail-close: blank means failed.
 */
export function validateWorkerHandoff(workerId: string, output: string): WorkerHandoff {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `worker '${workerId}' returned an empty hand-off — treated as failure (fail-close)`, workerId };
  }
  return { ok: true, output: trimmed, workerId };
}

export interface HandoffPart {
  readonly workerId: string;
  readonly output: string;
}

export type ParsedHandoffPart =
  | { readonly ok: true; readonly part: HandoffPart }
  | { readonly ok: false; readonly reason: string };

/**
 * Typed-schema validation of ONE worker→synthesizer hand-off part at the fan-in
 * seam (the second MAST cascade boundary, distinct from the worker boundary that
 * `parseWorkerResult` / `validateWorkerHandoff` guard). The fan-in builds each
 * part from the NEUTRALIZED worker output, not the raw value the worker boundary
 * checked — so a worker whose RAW output passed the non-empty hand-off check but
 * is ENTIRELY an injection span collapses to the placeholder
 * (`INJECTION_SPAN_PLACEHOLDER`): content-free, yet non-blank. Feeding that into
 * the synthesizer is information-withholding cascading downstream as if it were a
 * real answer. This is the schema contract for a part that may enter synthesis:
 *
 * - `workerId` is a non-empty (trimmed) string,
 * - `output` is a string with SUBSTANTIVE content — not blank/whitespace, and not
 *   solely the neutralization placeholder.
 *
 * Fail-close: a part that does not satisfy the schema is rejected with a reason
 * and MUST NOT reach the synthesizer / conflict / redundancy fan-in.
 */
export function parseHandoffPart(value: unknown): ParsedHandoffPart {
  if (!isHandoffPart(value)) {
    return { ok: false, reason: "hand-off part is not an object" };
  }
  if (value.output.length === 0) {
    return { ok: false, reason: `hand-off part '${value.workerId}' has a blank output (fail-close)` };
  }
  const trimmed = value.output.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `hand-off part '${value.workerId}' has a blank output (fail-close)` };
  }
  if (trimmed === INJECTION_SPAN_PLACEHOLDER) {
    return {
      ok: false,
      reason: `hand-off part '${value.workerId}' collapsed to the injection placeholder — no substantive content (fail-close)`
    };
  }
  return { ok: true, part: { output: value.output, workerId: value.workerId } };
}

function isHandoffPart(value: unknown): value is { readonly workerId: string; readonly output: string } {
  return isRecord(value)
    && typeof value.workerId === "string"
    && value.workerId.trim().length > 0
    && typeof value.output === "string";
}

export function createWorkerResult(
  workerId: string,
  output: string,
  input: AgentRunInput,
  metadata: JsonObject = {}
): AgentRunResult {
  return {
    response: {
      id: createRunId("response"),
      model: input.model,
      output,
      raw: metadata
    },
    runId: input.runId ?? createRunId(workerId)
  };
}
