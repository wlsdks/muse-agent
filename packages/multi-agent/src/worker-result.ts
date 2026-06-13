import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
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
