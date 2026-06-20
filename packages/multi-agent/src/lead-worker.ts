import { detectPairwiseContradictions, lexicalTokens } from "@muse/agent-core";

import { decomposeRequestWithKind, shouldDecompose, type Subtask } from "./decompose-trigger.js";

export type SubtaskStatus = "completed" | "failed" | "ungrounded";

/** Verdict of the fan-in objective-satisfaction check. */
export interface SynthesisVerdict {
  readonly satisfied: boolean;
  /** Texts of completed sub-tasks whose result the synthesis dropped. */
  readonly missing: readonly string[];
}

/**
 * Objective-satisfaction verifier on the FAN-IN (maker != judge): does the
 * synthesized answer actually INCORPORATE each completed sub-task's result, or did it
 * silently drop one? A confident synthesis that omits a worker's output is the MAST
 * "done-by-self-report / unaware of termination" failure (agent-testing.md: a "done"
 * signal must be backed by a real verification step). Deterministic + conservative —
 * a COMPLETED, non-empty sub-task whose salient tokens are ENTIRELY absent from the
 * synthesis is flagged dropped; a paraphrase (any shared salient token) passes. Pure.
 */
/**
 * Cross-subtask CONTRADICTION on the fan-in (the grounding edge applied to the
 * fan-OUT): when two COMPLETED workers assert disagreeing values on the SAME topic
 * (e.g. "deadline is Tuesday" vs "Wednesday"), the synthesis would silently
 * concatenate an internally-inconsistent answer — both halves individually passed
 * their per-subtask grounding gate, so the fan-in passes a self-contradicting claim
 * (a GROUNDED != TRUE fabrication coverage-checking can't catch). Reuses the SHARED
 * pairwise contradiction detector so the policy never drifts from the evidence layer.
 * Returns a human caption per conflicting pair. Fail-soft over the injected embed.
 */
export async function detectSubtaskConflicts(
  executions: readonly SubtaskExecution[],
  embed: (text: string) => Promise<readonly number[]>
): Promise<readonly string[]> {
  const completed = executions.filter(
    (e): e is SubtaskExecution & { output: string } =>
      e.status === "completed" && typeof e.output === "string" && e.output.trim().length > 0
  );
  if (completed.length < 2) return [];
  const pairs = await detectPairwiseContradictions(completed.map((e) => e.output), embed);
  return pairs.map((p) => `"${completed[p.aIndex]!.subtask.text}" vs "${completed[p.bIndex]!.subtask.text}"`);
}

export function verifySynthesisCoverage(finalAnswer: string, executions: readonly SubtaskExecution[]): SynthesisVerdict {
  const answerTokens = lexicalTokens(finalAnswer);
  const missing: string[] = [];
  for (const ex of executions) {
    if (ex.status !== "completed") continue;
    const out = ex.output?.trim();
    if (!out) continue;
    const tokens = [...lexicalTokens(out)];
    if (tokens.length > 0 && !tokens.some((t) => answerTokens.has(t))) missing.push(ex.subtask.text);
  }
  return { missing, satisfied: missing.length === 0 };
}

/**
 * Build the prompt for a verifier-gated re-synthesis: the original request plus an
 * explicit reminder of the sub-results the previous synthesis dropped, so the retry
 * is targeted (not a blind "try again" that repeats the same omission).
 */
function reinforceSynthesisRequest(request: string, missing: readonly string[]): string {
  return `${request}\n\n[누락 보완 — 직전 종합에서 다음 하위 결과가 빠졌다. 이번 답변에는 반드시 모두 반영하라: ${missing.join("; ")}]`;
}

export interface SubtaskOutput {
  readonly output: string;
  readonly sources?: readonly string[];
}

export interface SubtaskExecution {
  readonly subtask: Subtask;
  readonly status: SubtaskStatus;
  readonly output?: string;
  readonly error?: string;
}

export interface LeadWorkerResult {
  readonly decomposed: boolean;
  readonly subtasks: readonly Subtask[];
  readonly executions: readonly SubtaskExecution[];
  readonly finalAnswer: string;
  readonly reason: string;
  /**
   * Set when the fan-in `verifySynthesis` judged the synthesis INCOMPLETE — the
   * texts of completed sub-tasks whose result the answer dropped. Absent ⇒ the
   * synthesis covered every completed sub-task (or no verifier was supplied). The
   * caller surfaces it rather than returning a confident-but-incomplete answer.
   */
  readonly synthesisIncomplete?: readonly string[];
  /**
   * Set when the fan-in `detectConflicts` found COMPLETED sub-answers that
   * CONTRADICT each other on the same topic — a caption per conflicting pair. The
   * caller surfaces it so an internally-inconsistent answer is flagged, not passed
   * off as a single confident truth.
   */
  readonly subtaskConflicts?: readonly string[];
}

export interface LeadWorkerDeps {
  /**
   * Run ONE sub-task in its OWN clean context (a real sub-agent). For an
   * INDEPENDENT split (a list) `priorContext` is undefined — the worker receives
   * only its sub-task text, never the others' outputs (isolation preserves the
   * lead's context budget and keeps each worker focused). For a SEQUENCED split
   * ("먼저 … 그 다음 …") the completed prior steps' outputs ARE passed so a
   * downstream step can act on the upstream RESULT (closing the MAST
   * reasoning-action mismatch where step 2 would otherwise run blind).
   */
  readonly execute: (subtask: Subtask, priorContext?: readonly string[]) => Promise<SubtaskOutput>;
  /** Fan-in: combine the completed sub-task outputs into the final answer. */
  readonly synthesize: (request: string, executions: readonly SubtaskExecution[]) => Promise<string>;
  /**
   * Per-sub-task grounding verifier. A false verdict marks the execution
   * `ungrounded` (fail-close — its output is withheld from the lead, never
   * silently merged). Absent → no per-sub-task gate (the caller's own gate
   * still runs on the synthesized answer).
   */
  readonly groundingGate?: (output: SubtaskOutput, subtask: Subtask) => Promise<boolean> | boolean;
  /**
   * Model planner for a complex request with NO literal structure to split
   * (a broad-scope aggregation). Invoked only when deterministic
   * decomposition yields a single task; must return 2+ sub-task texts to take
   * effect, else the request runs single (fail to no-decompose).
   */
  readonly planner?: (request: string) => Promise<readonly string[]>;
  /**
   * Fan-in objective-satisfaction verifier (maker != judge): given the synthesized
   * answer + the executions, return whether it incorporated every completed sub-task.
   * A `!satisfied` verdict marks the result `synthesisIncomplete` so a dropped worker
   * surfaces instead of being returned as confident-complete. Absent ⇒ no fan-in
   * check (back-compat). Wire {@link verifySynthesisCoverage} for the deterministic
   * default.
   */
  readonly verifySynthesis?: (request: string, finalAnswer: string, executions: readonly SubtaskExecution[]) => SynthesisVerdict | Promise<SynthesisVerdict>;
  /**
   * Fan-in cross-subtask conflict detector (the grounding edge on the fan-OUT):
   * given the executions, return a caption per pair of COMPLETED sub-answers that
   * contradict each other. A non-empty result marks {@link LeadWorkerResult.subtaskConflicts}.
   * Absent ⇒ no conflict check (back-compat). Wire {@link detectSubtaskConflicts}
   * (bound to a local embed) for the default.
   */
  readonly detectConflicts?: (executions: readonly SubtaskExecution[]) => Promise<readonly string[]>;
}

const MAX_SUBTASKS = 8;

async function runOne(subtask: Subtask, deps: LeadWorkerDeps, priorContext?: readonly string[]): Promise<SubtaskExecution> {
  let produced: SubtaskOutput;
  try {
    produced = await deps.execute(subtask, priorContext);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), status: "failed", subtask };
  }

  // Blank output is fail-close, never a silent success: a worker that returned
  // nothing did NOT complete its sub-task, so it must not be folded into the
  // synthesis as if it had (the "blank = success" trap the handoff validator
  // closes on the orchestrator path — closed here too).
  if (produced.output.trim().length === 0) {
    return { error: "empty sub-task output (fail-close)", output: produced.output, status: "failed", subtask };
  }

  if (deps.groundingGate) {
    let grounded: boolean;
    try {
      grounded = await deps.groundingGate(produced, subtask);
    } catch {
      grounded = false;
    }
    if (!grounded) {
      return { output: produced.output, status: "ungrounded", subtask };
    }
  }

  return { output: produced.output, status: "completed", subtask };
}

/**
 * Lead-worker fan-out: a complex request is split into independent sub-tasks,
 * each run in its own clean context (sequential on a single GPU), then the lead
 * synthesizes one answer. A simple request bypasses the whole machinery and
 * runs as a single execution. Failures NEVER abort the run or silently vanish
 * (MAST "information withholding"): a failed/ungrounded sub-task is recorded
 * and surfaced to `synthesize`, which decides how to fold partial results.
 * Termination is bounded — at most {@link MAX_SUBTASKS} sub-tasks run.
 */
function normalizeSubtaskText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * MAST #3 (no duplicated sub-agent work): a decomposer OR model planner can emit two
 * case/whitespace-identical subtasks; on a single GPU that runs the SAME work twice
 * (Anthropic's "vague sub-agent instructions → identical searches" failure mode).
 * Dedup by normalized text — keep the first occurrence's original text, drop empties,
 * re-id sequentially — BEFORE fan-out. Pure; covers both the structural and planner
 * subtask sources since both flow through here.
 */
export function dedupeSubtasks(subtasks: readonly Subtask[]): Subtask[] {
  const seen = new Set<string>();
  const out: Subtask[] = [];
  for (const subtask of subtasks) {
    const norm = normalizeSubtaskText(subtask.text);
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ id: `subtask_${(out.length + 1).toString()}`, text: subtask.text });
  }
  return out;
}

export async function runLeadWorkerTask(request: string, deps: LeadWorkerDeps): Promise<LeadWorkerResult> {
  const decision = shouldDecompose(request);

  if (!decision.decompose) {
    const single: Subtask = { id: "subtask_1", text: request.trim() };
    const execution = await runOne(single, deps);
    return {
      decomposed: false,
      executions: [execution],
      finalAnswer: execution.status === "completed" ? (execution.output ?? "") : "",
      reason: `single-agent (${decision.reason})`,
      subtasks: [single]
    };
  }

  const decomposed = decomposeRequestWithKind(request);
  let subtasks = decomposed.subtasks;
  // A SEQUENCED structural split threads prior step outputs forward; a model-PLANNED
  // split is a broad aggregation of independent angles (no ordered dependency).
  let sequenced = decomposed.sequenced;
  let planned = false;
  if (subtasks.length < 2 && deps.planner) {
    try {
      const texts = (await deps.planner(request)).map((t) => t.trim()).filter(Boolean);
      if (texts.length >= 2) {
        subtasks = texts.map((text, index) => ({ id: `subtask_${index + 1}`, text }));
        planned = true;
        sequenced = false;
      }
    } catch {
      // planner failure is non-fatal — fall through to the single sub-task
    }
  }

  subtasks = dedupeSubtasks(subtasks);

  const truncated = subtasks.length > MAX_SUBTASKS;
  if (truncated) subtasks = subtasks.slice(0, MAX_SUBTASKS);

  const executions: SubtaskExecution[] = [];
  for (const subtask of subtasks) {
    // For a sequenced (dependent) split, thread the COMPLETED prior steps' outputs
    // into this worker so a downstream step can act on the upstream result. Only
    // completed outputs are threaded — a failed/ungrounded/blank step is NOT fed
    // forward (fail-close: never seed the next step with garbage). An independent
    // list passes nothing (isolation preserved).
    const priorContext = sequenced
      ? executions.flatMap((e) => (e.status === "completed" && e.output ? [e.output] : []))
      : [];
    executions.push(await runOne(subtask, deps, priorContext.length > 0 ? priorContext : undefined));
  }

  // Fan-in objective-satisfaction (maker != judge): did the synthesis incorporate
  // every completed sub-task, or silently drop one? Fail-soft — a verifier error
  // leaves the answer as-is (never blocks the run).
  const runSynthesis = async (synthesisRequest: string): Promise<{ answer: string; missing?: readonly string[]; verified: boolean }> => {
    const answer = await deps.synthesize(synthesisRequest, executions);
    if (!deps.verifySynthesis) return { answer, verified: false };
    try {
      const verdict = await deps.verifySynthesis(request, answer, executions);
      return { answer, missing: !verdict.satisfied && verdict.missing.length > 0 ? verdict.missing : undefined, verified: true };
    } catch {
      return { answer, verified: false }; // verifier unavailable — surface nothing, return the answer
    }
  };

  const first = await runSynthesis(request);
  let finalAnswer = first.answer;
  let synthesisIncomplete = first.missing;
  // Verifier-gated SINGLE re-synthesis (reflection-guard): a bare unverified retry
  // repeats the drop ~85% of the time (arXiv 2510.18254), so the retry is backed by
  // the deterministic `verifySynthesisCoverage` AND accepted ONLY if the retry was
  // itself VERIFIED and drops STRICTLY FEWER sub-results — a retry can never make the
  // answer worse, and a retry whose verifier errored is NOT accepted as "complete"
  // (we keep the original flagged answer rather than claim false coverage). The retry
  // prompt names what was dropped (reinforceSynthesisRequest), not a blind "try again".
  if (synthesisIncomplete && deps.verifySynthesis) {
    const retry = await runSynthesis(reinforceSynthesisRequest(request, synthesisIncomplete));
    if (retry.verified && (retry.missing?.length ?? 0) < synthesisIncomplete.length) {
      finalAnswer = retry.answer;
      synthesisIncomplete = retry.missing;
    }
  }
  // Fan-in cross-subtask conflict (the grounding edge on the fan-OUT): are two
  // completed sub-answers internally contradictory? Fail-soft — a detector error
  // leaves the answer as-is.
  let subtaskConflicts: readonly string[] | undefined;
  if (deps.detectConflicts) {
    try {
      const conflicts = await deps.detectConflicts(executions);
      if (conflicts.length > 0) subtaskConflicts = conflicts;
    } catch { /* detector unavailable — surface nothing */ }
  }
  const split = planned ? "model-planned" : "structural";
  const completed = executions.filter((e) => e.status === "completed").length;

  return {
    decomposed: subtasks.length > 1,
    executions,
    finalAnswer,
    reason:
      `${split} decomposition → ${completed}/${executions.length} sub-tasks grounded` +
      (truncated ? ` (capped at ${MAX_SUBTASKS})` : "") +
      (synthesisIncomplete ? ` · synthesis incomplete (${synthesisIncomplete.length.toString()} dropped)` : "") +
      (subtaskConflicts ? ` · ${subtaskConflicts.length.toString()} sub-answer conflict(s)` : ""),
    subtasks,
    ...(synthesisIncomplete ? { synthesisIncomplete } : {}),
    ...(subtaskConflicts ? { subtaskConflicts } : {})
  };
}
