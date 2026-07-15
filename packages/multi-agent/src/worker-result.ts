import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { INJECTION_SPAN_PLACEHOLDER } from "@muse/agent-core";
import { createRunId, type JsonObject } from "@muse/shared";

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
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "worker result is not an object" };
  }
  const candidate = value as { response?: { output?: unknown }; runId?: unknown };
  if (!candidate.response || typeof candidate.response !== "object") {
    return { ok: false, reason: "worker result has no response object" };
  }
  if (typeof candidate.response.output !== "string") {
    return { ok: false, reason: "worker response.output is not a string" };
  }
  if (typeof candidate.runId !== "string" || candidate.runId.length === 0) {
    return { ok: false, reason: "worker result has no runId" };
  }
  return { ok: true, result: value as AgentRunResult };
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
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "hand-off part is not an object" };
  }
  const candidate = value as { workerId?: unknown; output?: unknown };
  if (typeof candidate.workerId !== "string" || candidate.workerId.trim().length === 0) {
    return { ok: false, reason: "hand-off part has no workerId" };
  }
  if (typeof candidate.output !== "string") {
    return { ok: false, reason: `hand-off part '${candidate.workerId}' output is not a string` };
  }
  const trimmed = candidate.output.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: `hand-off part '${candidate.workerId}' has a blank output (fail-close)` };
  }
  if (trimmed === INJECTION_SPAN_PLACEHOLDER) {
    return {
      ok: false,
      reason: `hand-off part '${candidate.workerId}' collapsed to the injection placeholder — no substantive content (fail-close)`
    };
  }
  return { ok: true, part: { output: candidate.output, workerId: candidate.workerId } };
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
