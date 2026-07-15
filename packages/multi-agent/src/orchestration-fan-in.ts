import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import { neutralizeInjectionSpans } from "@muse/agent-core";
import { trimToolOutput } from "@muse/memory";
import { createRunId, errorMessage } from "@muse/shared";
import { setTimeout as sleepWithTimer } from "node:timers/promises";
import type { OrchestrationStepResult } from "./index.js";
import { parseHandoffPart } from "./worker-result.js";
import { joinMessages } from "./workers.js";

export { errorMessage };

/** The user's request to verify the final answer against — the latest user turn,
 *  or the whole transcript if there is none. */
export function objectiveFromInput(input: AgentRunInput): string {
  const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
  return (lastUser?.content ?? joinMessages(input.messages)).trim();
}

/**
 * Run `operation` under an optional wall-clock deadline (MAST "unaware of
 * termination"). Without one it is a transparent passthrough. With one, a hung
 * operation rejects at the deadline so the caller's existing catch can fail-soft
 * — bounding the WAIT, not the underlying compute (no provider cancellation; the
 * abandoned call may still run). The timer is always cleared so a fast operation
 * leaves no dangling handle. Shared by the per-worker guard and the fan-in
 * synthesis/verification calls so the policy never drifts.
 */
export async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return operation();
  }
  const timeoutController = new AbortController();
  const deadline = sleepWithTimer(timeoutMs, undefined, { signal: timeoutController.signal }).then(() => {
    throw new Error(`${label} exceeded the ${timeoutMs.toString()}ms deadline`);
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    timeoutController.abort();
  }
}

export async function buildOrchestrationResponse(
  runId: string,
  model: string,
  results: readonly OrchestrationStepResult[],
  maxOutputCharsPerWorker: number | undefined,
  summarizeWorkerOutput: ((workerId: string, output: string) => Promise<string>) | undefined,
  synthesizeFinalAnswer?: (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>, guidance?: string) => Promise<string>,
  objective?: string,
  verifyFinalAnswer?: (objective: string, output: string) => Promise<{ readonly satisfied: boolean; readonly missing?: string }>,
  detectConflicts?: (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) => Promise<readonly string[]>,
  detectRedundancies?: (parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) => Promise<readonly string[]>,
  synthesisTimeoutMs?: number
): Promise<AgentRunResult["response"]> {
  const cap = maxOutputCharsPerWorker && maxOutputCharsPerWorker > 0 ? maxOutputCharsPerWorker : undefined;
  const { concatenated, safeOutputs } = await projectWorkerOutputs(results, cap, summarizeWorkerOutput);
  const completedParts = buildCompletedParts(results, safeOutputs);

  const synthesized = await synthesizeAndVerify(
    completedParts,
    concatenated,
    synthesizeFinalAnswer,
    objective,
    verifyFinalAnswer,
    synthesisTimeoutMs
  );
  const { conflicts, output, redundancies } = await detectFanInIssues(
    completedParts,
    synthesized.output,
    detectConflicts,
    detectRedundancies
  );

  return {
    id: createRunId("multi_agent_response"),
    model,
    output,
    raw: {
      runId,
      workers: results.map((result) => ({
        status: result.status,
        workerId: result.workerId
      })),
      ...(synthesized.verification ? { verification: synthesized.verification } : {}),
      ...(conflicts ? { conflicts } : {}),
      ...(redundancies ? { redundancies } : {})
    }
  };
}

/**
 * Per-worker projection: neutralize each completed worker's output ONCE,
 * BEFORE summarize/cap, and feed BOTH fan-ins (concat + synthesizer parts)
 * from the SAME safe value — a poisoned worker's embedded instruction /
 * forged `[from system]` citation must not reach the lead's final answer
 * (OWASP ASI07). `safeOutputs` is fan-in-only; the tracked
 * `results[].result.response.output` keeps the RAW output for trace
 * fidelity.
 */
async function projectWorkerOutputs(
  results: readonly OrchestrationStepResult[],
  cap: number | undefined,
  summarizeWorkerOutput: ((workerId: string, output: string) => Promise<string>) | undefined
): Promise<{ readonly concatenated: string; readonly safeOutputs: ReadonlyArray<string | undefined> }> {
  const safeOutputs = results.map((r) =>
    r.status === "completed" ? neutralizeInjectionSpans(r.result?.response.output ?? "") : undefined
  );
  const projected = await Promise.all(results.map(async (result, i) => {
    if (result.status !== "completed") {
      return `## ${result.workerId}\nError: ${result.error ?? "unknown error"}`;
    }
    const safe = safeOutputs[i] ?? "";
    const summarized = summarizeWorkerOutput
      ? await applyWorkerSummarizer(result.workerId, safe, summarizeWorkerOutput)
      : safe;
    return `## ${result.workerId}\n${capWorkerOutput(result.workerId, summarized, cap)}`;
  }));
  return { concatenated: projected.join("\n\n"), safeOutputs };
}

/**
 * Enforce the typed hand-off schema at THIS seam (fan-in is the second MAST
 * cascade boundary): the parts are built from the NEUTRALIZED output, so a
 * worker whose raw output passed the worker boundary but is entirely an
 * injection span has collapsed to the placeholder here — content-free yet
 * non-blank. `parseHandoffPart` drops such a part fail-close so the synthesizer
 * / conflict / redundancy fan-in never consumes a content-free hand-off as if
 * it were a real answer. The per-worker concatenation still shows every
 * completed worker honestly; only the FUSION inputs are schema-gated.
 */
function buildCompletedParts(
  results: readonly OrchestrationStepResult[],
  safeOutputs: ReadonlyArray<string | undefined>
): ReadonlyArray<{ readonly workerId: string; readonly output: string }> {
  return results
    .map((result, index) => ({ index, result }))
    .filter(({ result }) => result.status === "completed")
    .map(({ result, index }) => parseHandoffPart({ output: safeOutputs[index] ?? "", workerId: result.workerId }))
    .filter((parsed): parsed is { ok: true; part: { workerId: string; output: string } } => parsed.ok)
    .map((parsed) => parsed.part);
}

/**
 * Optional final-answer synthesis: fuse the completed workers into ONE
 * coherent answer, then verify against the original objective. On an
 * incomplete verdict, RE-SYNTHESISE ONCE with the missing piece as guidance
 * and re-verify — MAST's +15.6% is catch AND fix, not just flag. The answer
 * is only marked incomplete if it's STILL missing something after the single
 * retry (bounded — small-model coherence degrades past 2 hops). Fail-soft
 * throughout — a throwing / empty synthesizer or verifier keeps the prior
 * output, so the orchestration never loses its output.
 */
async function synthesizeAndVerify(
  completedParts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>,
  concatenated: string,
  synthesizeFinalAnswer: ((parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>, guidance?: string) => Promise<string>) | undefined,
  objective: string | undefined,
  verifyFinalAnswer: ((objective: string, output: string) => Promise<{ readonly satisfied: boolean; readonly missing?: string }>) | undefined,
  synthesisTimeoutMs: number | undefined
): Promise<{ readonly output: string; readonly verification?: { readonly satisfied: boolean; readonly missing?: string } }> {
  const trySynthesize = async (guidance?: string): Promise<string | undefined> => {
    if (!synthesizeFinalAnswer || completedParts.length === 0) {
      return undefined;
    }
    try {
      const s = await withDeadline(() => synthesizeFinalAnswer(completedParts, guidance), synthesisTimeoutMs, "fan-in synthesis");
      return typeof s === "string" && s.trim().length > 0 ? s : undefined;
    } catch {
      return undefined;
    }
  };

  let output = (await trySynthesize()) ?? concatenated;

  let verification: { readonly satisfied: boolean; readonly missing?: string } | undefined;
  if (verifyFinalAnswer && objective && objective.trim().length > 0 && output.trim().length > 0) {
    try {
      let verdict = await withDeadline(() => verifyFinalAnswer(objective, output), synthesisTimeoutMs, "fan-in verification");
      if (!verdict.satisfied && verdict.missing && verdict.missing.trim().length > 0) {
        const fixed = await trySynthesize(`Make sure the final answer also fully covers: ${verdict.missing.trim()}`);
        if (fixed && fixed.trim() !== output.trim()) {
          output = fixed;
          verdict = await withDeadline(() => verifyFinalAnswer(objective, output), synthesisTimeoutMs, "fan-in verification");
        }
      }
      verification = verdict.missing ? { missing: verdict.missing, satisfied: verdict.satisfied } : { satisfied: verdict.satisfied };
      if (!verdict.satisfied) {
        const gap = verdict.missing?.trim();
        output = `${output}\n\n⚠ This answer may be incomplete${gap ? ` — still missing: ${gap}` : "."}`;
      }
    } catch {
      // keep the answer; verification is best-effort
    }
  }

  return verification ? { output, verification } : { output };
}

/**
 * Cross-worker conflict (the grounding edge on the fan-OUT): are two COMPLETED
 * workers internally contradictory? Cross-worker REDUNDANCY (step-repetition,
 * the complement of the conflict check): two COMPLETED workers produced
 * near-identical answers — one added no distinct value. Both run on the SAME
 * neutralized parts the synthesizer saw, advisory only, fail-soft — a
 * throwing detector leaves the answer as-is. A non-empty result appends one
 * honest line so an internally-inconsistent or duplicated-work answer is
 * flagged, not passed off as independent corroboration.
 */
async function detectFanInIssues(
  completedParts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>,
  output: string,
  detectConflicts: ((parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) => Promise<readonly string[]>) | undefined,
  detectRedundancies: ((parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>) => Promise<readonly string[]>) | undefined
): Promise<{ readonly conflicts?: readonly string[]; readonly output: string; readonly redundancies?: readonly string[] }> {
  let result = output;

  let conflicts: readonly string[] | undefined;
  if (detectConflicts && completedParts.length >= 2) {
    try {
      const found = await detectConflicts(completedParts);
      if (found.length > 0) {
        conflicts = found;
        result = `${result}\n\n⚠ Workers disagree on the same point — reconcile before trusting: ${found.join("; ")}`;
      }
    } catch {
      // detector unavailable — surface nothing, keep the answer
    }
  }

  let redundancies: readonly string[] | undefined;
  if (detectRedundancies && completedParts.length >= 2) {
    try {
      const found = await detectRedundancies(completedParts);
      if (found.length > 0) {
        redundancies = found;
        result = `${result}\n\nℹ Workers produced near-identical answers (possible duplicated work): ${found.join("; ")}`;
      }
    } catch {
      // detector unavailable — surface nothing, keep the answer
    }
  }

  return { conflicts, output: result, redundancies };
}

async function applyWorkerSummarizer(
  workerId: string,
  output: string,
  summarize: (workerId: string, output: string) => Promise<string>
): Promise<string> {
  if (output.length === 0) {
    return output;
  }
  try {
    const summary = await summarize(workerId, output);
    return typeof summary === "string" && summary.length > 0 ? summary : output;
  } catch {
    return output;
  }
}

function capWorkerOutput(workerId: string, output: string, cap: number | undefined): string {
  if (!cap) {
    return output;
  }
  return trimToolOutput(output, {
    hint: `agent ${workerId} output trimmed by orchestrator fan-in`,
    maxChars: cap
  }).output;
}
