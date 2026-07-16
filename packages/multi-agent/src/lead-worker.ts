import { comparableScript, detectPairwiseContradictions, detectRedundantPairs, lexicalTokens, neutralizeInjectionSpans } from "@muse/agent-core";
import { errorMessage } from "@muse/shared";

import { decomposeRequestWithKind, shouldDecompose, type Subtask } from "./decompose-trigger.js";

export type SubtaskStatus = "completed" | "failed" | "ungrounded";

/** Verdict of the fan-in objective-satisfaction check. */
export interface SynthesisVerdict {
  readonly satisfied: boolean;
  /** Texts of completed sub-tasks whose result the synthesis dropped. */
  readonly missing: readonly string[];
}

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

/**
 * The orchestrate-path twin of {@link detectSubtaskConflicts}: given the COMPLETED
 * workers' `{ workerId, output }` parts (the same NEUTRALIZED shape the orchestrator's
 * `synthesizeFinalAnswer`/`detectConflicts` deps receive), flag any pair of workers
 * that contradict each other on the same topic. Reuses the SHARED pairwise
 * contradiction detector so the orchestrate fan-in never drifts from the lead-worker
 * one or the evidence layer. Returns a caption per conflicting pair (by workerId).
 * Fail-soft over the injected embed (a comparison failure → no conflict, never a throw).
 */
export async function detectFanInConflicts(
  parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>,
  embed: (text: string) => Promise<readonly number[]>
): Promise<readonly string[]> {
  const nonEmpty = parts.filter((p) => typeof p.output === "string" && p.output.trim().length > 0);
  if (nonEmpty.length < 2) return [];
  const pairs = await detectPairwiseContradictions(nonEmpty.map((p) => p.output), embed);
  return pairs.map((p) => `"${nonEmpty[p.aIndex]!.workerId}" vs "${nonEmpty[p.bIndex]!.workerId}"`);
}

/**
 * The redundancy (step-repetition) twin of {@link detectSubtaskConflicts}: flag any pair
 * of COMPLETED sub-answers that are near-identical — one worker restated another's result
 * adding nothing (MAST FM-1.3, arXiv:2503.13657). Reuses the shared {@link detectRedundantPairs}
 * so the policy never drifts from the evidence layer. Returns a caption per redundant pair
 * (by sub-task text). Fail-soft over the injected embed.
 */
export async function detectSubtaskRedundancies(
  executions: readonly SubtaskExecution[],
  embed: (text: string) => Promise<readonly number[]>
): Promise<readonly string[]> {
  const completed = executions.filter(
    (e): e is SubtaskExecution & { output: string } =>
      e.status === "completed" && typeof e.output === "string" && e.output.trim().length > 0
  );
  if (completed.length < 2) return [];
  const pairs = await detectRedundantPairs(completed.map((e) => e.output), embed);
  return pairs.map((p) => `"${completed[p.aIndex]!.subtask.text}" ≈ "${completed[p.bIndex]!.subtask.text}"`);
}

/**
 * The orchestrate-path twin of {@link detectSubtaskRedundancies} (and the redundancy
 * complement of {@link detectFanInConflicts}): given the COMPLETED workers' parts, flag
 * any pair of workers whose outputs are near-identical — one restated another's answer
 * adding nothing (MAST FM-1.3 step repetition). In a fan-OUT where several workers answer
 * the SAME question, this catches a worker that contributed no distinct value. Reuses the
 * shared {@link detectRedundantPairs}. Returns a caption per pair (by workerId). Fail-soft.
 */
export async function detectFanInRedundancy(
  parts: ReadonlyArray<{ readonly workerId: string; readonly output: string }>,
  embed: (text: string) => Promise<readonly number[]>
): Promise<readonly string[]> {
  const nonEmpty = parts.filter((p) => typeof p.output === "string" && p.output.trim().length > 0);
  if (nonEmpty.length < 2) return [];
  const pairs = await detectRedundantPairs(nonEmpty.map((p) => p.output), embed);
  return pairs.map((p) => `"${nonEmpty[p.aIndex]!.workerId}" ≈ "${nonEmpty[p.bIndex]!.workerId}"`);
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
 * Reasoning-action alignment on the SEQUENCED handoff (MAST FM-2.6 reasoning-action
 * mismatch, arXiv:2503.13657 — the #2 multi-agent failure mode at 13.2%). A sequenced
 * split exists SPECIFICALLY so a downstream step can act on its upstream RESULT (it is
 * handed the completed prior steps' outputs as priorContext). This verifies the step
 * actually ENGAGED that result: a COMPLETED step (index ≥ 1) whose output shares ZERO
 * content tokens with EVERY same-script upstream output ran "blind" — it ignored the
 * dependency it was given. Returns a caption per blind step. Advisory-only.
 *
 * Calibration (honest): the bar is "shares NOTHING" — the inverse of
 * {@link verifySynthesisCoverage}'s "shares ≥1 token" test. A downstream that carries
 * forward any upstream number/entity/noun is never flagged; but a downstream that
 * legitimately PARAPHRASES/CLASSIFIES/DECIDES without repeating a surface token (e.g.
 * upstream "Q1 revenue 4.2M" → downstream "approved, proceeding") shares zero LEXICAL
 * tokens and WOULD be flagged — a real false-positive class. This is therefore a
 * conservative-RECALL signal and is **ADVISORY-ONLY** (a caption + reason fragment, never a
 * gate / re-synthesis / blocked answer): a spurious flag is harmless. Do NOT wire it into
 * any non-advisory path without first upgrading the bar to SEMANTIC similarity (embedder
 * cosine, mirroring the redundancy detector). Same-script gate (fail-open) drops cross-script
 * upstream. Pure; caller runs it ONLY for a sequenced split (independent lists aren't checked).
 */
export function verifySequencedDependencyUse(executions: readonly SubtaskExecution[]): readonly string[] {
  const gaps: string[] = [];
  for (let i = 1; i < executions.length; i++) {
    const step = executions[i]!;
    const stepOut = step.status === "completed" ? step.output?.trim() : undefined;
    if (!stepOut) continue;
    const stepTokens = lexicalTokens(stepOut);
    if (stepTokens.size === 0) continue;
    const upstream = executions
      .slice(0, i)
      .filter((e): e is SubtaskExecution & { output: string } =>
        e.status === "completed" && typeof e.output === "string" && e.output.trim().length > 0)
      .filter((e) => comparableScript(stepOut, e.output));
    if (upstream.length === 0) continue; // no same-script upstream to verify against (fail-open)
    const engagedUpstream = upstream.some((e) => {
      for (const t of lexicalTokens(e.output)) {
        if (stepTokens.has(t)) return true;
      }
      return false;
    });
    if (!engagedUpstream) gaps.push(step.subtask.text);
  }
  return gaps;
}

/**
 * Build the prompt for a verifier-gated re-synthesis: the original request plus an
 * explicit reminder of the sub-results the previous synthesis dropped, so the retry
 * is targeted (not a blind "try again" that repeats the same omission).
 */
function reinforceSynthesisRequest(request: string, missing: readonly string[]): string {
  return `${request}\n\n[누락 보완 — 직전 종합에서 다음 하위 결과가 빠졌다. 이번 답변에는 반드시 모두 반영하라: ${missing.join("; ")}]`;
}

/**
 * When the sub-task list was TRUNCATED to MAX_SUBTASKS, tell the synthesizer the answer
 * is PARTIAL — the dropped items never executed (so verifySynthesisCoverage can't flag
 * them; they're not in `executions`), and a synthesis that presents the survivors as a
 * complete answer over a larger request is a GROUNDED≠TRUE leak in the answer TEXT (the
 * channel the user reads, not just the --json flag). Mirrors reinforceSynthesisRequest:
 * appends an explicit directive so the model caveats its coverage.
 */
function truncatedSynthesisRequest(request: string, dropped: number): string {
  return `${request}\n\n[부분 응답 — 요청 항목이 많아 ${dropped.toString()}개가 처리되지 않았다. 이 답변은 일부 항목만 다루므로, 누락이 있음을 반드시 명시하라.]`;
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
  /**
   * The sources this worker retrieved, kept STATUS-LINKED. A gated (ungrounded) or
   * failed sub-task's sources must NOT leak into the merged evidence the final answer
   * is graded on — else the synthesis could be marked grounded against a source no
   * surviving sub-task used (a fabricated citation). The caller filters to
   * `status === "completed"` before merging.
   */
  readonly sources?: readonly string[];
}

export interface LeadWorkerResult {
  readonly decomposed: boolean;
  readonly subtasks: readonly Subtask[];
  readonly executions: readonly SubtaskExecution[];
  readonly finalAnswer: string;
  readonly reason: string;
  /**
   * `true` when the sub-task list exceeded {@link MAX_SUBTASKS} and was capped — a
   * STRUCTURED signal so a machine consumer (`muse ask --json`) learns the answer is
   * PARTIAL (some requested items were dropped), instead of inferring it from the
   * reason string. Silent truncation presented as complete is a GROUNDED≠TRUE leak.
   */
  readonly truncated: boolean;
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
  /**
   * Set when the fan-in `detectRedundancies` found COMPLETED sub-answers that are
   * near-IDENTICAL — one worker restated another's result adding nothing (MAST
   * FM-1.3 step repetition). A caption per redundant pair, surfaced so the caller
   * knows a sub-task did duplicate work (the complement of {@link subtaskConflicts}).
   */
  readonly subtaskRedundancies?: readonly string[];
  /**
   * Set (for a SEQUENCED split only) when a completed downstream step ignored the
   * upstream RESULT it was handed — its output shares no content token with any
   * upstream output (MAST FM-2.6 reasoning-action mismatch). A caption per blind step.
   */
  readonly reasoningActionGaps?: readonly string[];
  /**
   * Machine-readable coordination-health summary for a DECOMPOSED run: true ONLY when the
   * fan-in is clean — no `subtaskConflicts`, no `subtaskRedundancies`, no `reasoningActionGaps`,
   * and no `synthesisIncomplete`. DERIVED from those signals (never asserted), so it can never
   * claim health it didn't check. Undefined for a single-agent / all-failed run (no fan-in to summarize).
   */
  readonly coordinationHealthy?: boolean;
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
  /**
   * Fan-in REDUNDANCY detector (step-repetition guard): given the executions, return a
   * caption per pair of COMPLETED sub-answers that are near-identical (one adds nothing).
   * A non-empty result marks {@link LeadWorkerResult.subtaskRedundancies}. Absent ⇒ no
   * redundancy check (back-compat). Wire {@link detectSubtaskRedundancies} (bound to a
   * local embed) for the default.
   */
  readonly detectRedundancies?: (executions: readonly SubtaskExecution[]) => Promise<readonly string[]>;
}

const MAX_SUBTASKS = 8;

async function runOne(subtask: Subtask, deps: LeadWorkerDeps, priorContext?: readonly string[]): Promise<SubtaskExecution> {
  let produced: SubtaskOutput;
  try {
    produced = await deps.execute(subtask, priorContext);
  } catch (error) {
    return { error: errorMessage(error), status: "failed", subtask };
  }

  let outputValue: unknown;
  let sourcesValue: unknown;
  try {
    if (!produced || typeof produced !== "object") {
      return { error: "sub-task result is not an object (fail-close)", status: "failed", subtask };
    }
    outputValue = produced.output;
    sourcesValue = produced.sources;
  } catch {
    return { error: "sub-task result access failed (fail-close)", status: "failed", subtask };
  }
  if (typeof outputValue !== "string") {
    return { error: "sub-task result has no string output (fail-close)", status: "failed", subtask };
  }

  // Blank output is fail-close, never a silent success: a worker that returned
  // nothing did NOT complete its sub-task, so it must not be folded into the
  // synthesis as if it had (the "blank = success" trap the handoff validator
  // closes on the orchestrator path — closed here too).
  let sources: string[] | undefined;
  try {
    if (Array.isArray(sourcesValue) && sourcesValue.every((source) => typeof source === "string")) {
      sources = [...sourcesValue];
    }
  } catch {
    // Sources are diagnostic evidence, not execution control. Omit a hostile
    // or malformed container without letting it abort the sub-task result.
  }
  if (outputValue.trim().length === 0) {
    return { error: "empty sub-task output (fail-close)", output: outputValue, ...(sources ? { sources } : {}), status: "failed", subtask };
  }

  // A worker that consumed a poisoned source can carry an embedded instruction
  // ("ignore previous instructions") or a forged `[from system]` citation into the
  // lead's synthesis prompt + final answer (Prompt Infection / OWASP ASI07). Neutralize
  // the surviving (non-empty) output at this single fan-in funnel — it feeds synthesize,
  // verifySynthesisCoverage, detectSubtaskConflicts, and sequenced priorContext. Pure +
  // byte-identical on clean text, so benign outputs are unchanged; runs AFTER the raw
  // empty-check so fail-close is preserved (the neutralizer never empties).
  const output = neutralizeInjectionSpans(outputValue);

  if (deps.groundingGate) {
    let grounded: boolean;
    try {
      grounded = await deps.groundingGate(produced, subtask);
    } catch {
      grounded = false;
    }
    if (!grounded) {
      return { output, ...(sources ? { sources } : {}), status: "ungrounded", subtask };
    }
  }

  return { output, ...(sources ? { sources } : {}), status: "completed", subtask };
}

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

/**
 * Fan-out execution loop: run each sub-task in order, threading COMPLETED prior
 * outputs forward for a SEQUENCED split. Only completed outputs are threaded — a
 * failed/ungrounded/blank step is NOT fed forward (fail-close: never seed the next
 * step with garbage). An independent list passes nothing (isolation preserved). A
 * SEQUENCED dependent step (any step after the first) whose EVERY upstream step
 * failed/ungrounded has NOTHING to act on — running it blind fabricates a confident
 * result from an absent dependency (MAST reasoning-action mismatch / information
 * withholding), so it is fail-closed instead of executed. The first step (no priors
 * by design) always runs; an INDEPENDENT list never reaches that branch.
 */
async function executeSubtasks(subtasks: readonly Subtask[], deps: LeadWorkerDeps, sequenced: boolean): Promise<SubtaskExecution[]> {
  const executions: SubtaskExecution[] = [];
  for (const subtask of subtasks) {
    const priorContext = sequenced
      ? executions.flatMap((e) => (e.status === "completed" && e.output ? [e.output] : []))
      : [];
    if (sequenced && executions.length > 0 && priorContext.length === 0) {
      executions.push({
        error: "upstream sequenced step(s) failed — dependent step not run blind (fail-close)",
        status: "failed",
        subtask
      });
      continue;
    }
    executions.push(await runOne(subtask, deps, priorContext.length > 0 ? priorContext : undefined));
  }
  return executions;
}

interface SynthesisOutcome {
  readonly finalAnswer: string;
  readonly synthesisIncomplete?: readonly string[];
}

/**
 * Fan-in objective-satisfaction (maker != judge) plus its verifier-gated SINGLE
 * re-synthesis (reflection-guard): did the synthesis incorporate every completed
 * sub-task, or silently drop one? Fail-soft — a verifier error leaves the answer
 * as-is (never blocks the run). A bare unverified retry repeats the drop ~85% of
 * the time (arXiv 2510.18254), so the retry is backed by the deterministic
 * `verifySynthesisCoverage` AND accepted ONLY if the retry was itself VERIFIED and
 * drops STRICTLY FEWER sub-results — a retry can never make the answer worse, and a
 * retry whose verifier errored is NOT accepted as "complete" (we keep the original
 * flagged answer rather than claim false coverage). The retry prompt names what was
 * dropped (reinforceSynthesisRequest), not a blind "try again". The truncation
 * caveat is kept on the retry base too — a re-synthesis must not drop the partiality
 * directive just because it's adding the missing-coverage one.
 */
async function synthesizeWithRetryGate(
  request: string,
  executions: readonly SubtaskExecution[],
  truncated: boolean,
  droppedCount: number,
  deps: LeadWorkerDeps
): Promise<SynthesisOutcome> {
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

  const first = await runSynthesis(truncated ? truncatedSynthesisRequest(request, droppedCount) : request);
  let finalAnswer = first.answer;
  let synthesisIncomplete = first.missing;
  if (synthesisIncomplete && deps.verifySynthesis) {
    const retryBase = truncated ? truncatedSynthesisRequest(request, droppedCount) : request;
    const retry = await runSynthesis(reinforceSynthesisRequest(retryBase, synthesisIncomplete));
    if (retry.verified && (retry.missing?.length ?? 0) < synthesisIncomplete.length) {
      finalAnswer = retry.answer;
      synthesisIncomplete = retry.missing;
    }
  }
  return { finalAnswer, synthesisIncomplete };
}

interface CoordinationIssues {
  readonly subtaskConflicts?: readonly string[];
  readonly subtaskRedundancies?: readonly string[];
  readonly reasoningActionGaps?: readonly string[];
}

/**
 * Fan-in coordination-health checks over the completed executions: cross-subtask
 * CONTRADICTION (the grounding edge on the fan-OUT), step-REPETITION redundancy, and
 * — only for a SEQUENCED split — reasoning-action alignment (MAST FM-2.6: did each
 * completed downstream step actually engage the upstream RESULT it was handed?).
 * Fail-soft — a detector error leaves that signal unset rather than blocking the run.
 */
async function detectCoordinationIssues(
  executions: readonly SubtaskExecution[],
  sequenced: boolean,
  deps: LeadWorkerDeps
): Promise<CoordinationIssues> {
  let subtaskConflicts: readonly string[] | undefined;
  if (deps.detectConflicts) {
    try {
      const conflicts = await deps.detectConflicts(executions);
      if (conflicts.length > 0) subtaskConflicts = conflicts;
    } catch { /* detector unavailable — surface nothing */ }
  }
  let subtaskRedundancies: readonly string[] | undefined;
  if (deps.detectRedundancies) {
    try {
      const redundancies = await deps.detectRedundancies(executions);
      if (redundancies.length > 0) subtaskRedundancies = redundancies;
    } catch { /* detector unavailable — surface nothing */ }
  }
  let reasoningActionGaps: readonly string[] | undefined;
  if (sequenced) {
    const gaps = verifySequencedDependencyUse(executions);
    if (gaps.length > 0) reasoningActionGaps = gaps;
  }
  return { reasoningActionGaps, subtaskConflicts, subtaskRedundancies };
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
      subtasks: [single],
      truncated: false
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
  const droppedCount = truncated ? subtasks.length - MAX_SUBTASKS : 0;
  if (truncated) subtasks = subtasks.slice(0, MAX_SUBTASKS);

  const executions = await executeSubtasks(subtasks, deps, sequenced);

  const completed = executions.filter((e) => e.status === "completed").length;
  // Fail-close: a decomposition where ZERO sub-tasks grounded has nothing to fuse —
  // handing only failed/ungrounded executions to the synthesizer fabricates a confident
  // answer from absent evidence (fabrication-floor breach; MAST proceed-despite-failure).
  // Skip synthesis entirely and mirror the single-agent path's honest-empty answer.
  if (completed === 0) {
    return {
      decomposed: subtasks.length > 1,
      executions,
      finalAnswer: "",
      reason:
        `${planned ? "model-planned" : "structural"} decomposition → 0/${executions.length} sub-tasks grounded (no grounded answer)` +
        (truncated ? ` (capped at ${MAX_SUBTASKS})` : ""),
      subtasks,
      truncated
    };
  }

  const { finalAnswer, synthesisIncomplete } = await synthesizeWithRetryGate(request, executions, truncated, droppedCount, deps);
  const { subtaskConflicts, subtaskRedundancies, reasoningActionGaps } = await detectCoordinationIssues(executions, sequenced, deps);
  const split = planned ? "model-planned" : "structural";

  return {
    // Derived from the REAL fan-in signals (each local is undefined when clean, a
    // non-empty caption list when not): a single machine-readable boolean a consumer
    // can trust — true ONLY when no contradiction, no redundancy, no blind sequenced
    // step, and no dropped sub-result. Never a hardcoded green.
    coordinationHealthy: !subtaskConflicts && !subtaskRedundancies && !reasoningActionGaps && !synthesisIncomplete,
    decomposed: subtasks.length > 1,
    executions,
    finalAnswer,
    reason:
      `${split} decomposition → ${completed}/${executions.length} sub-tasks grounded` +
      (truncated ? ` (capped at ${MAX_SUBTASKS})` : "") +
      (synthesisIncomplete ? ` · synthesis incomplete (${synthesisIncomplete.length.toString()} dropped)` : "") +
      (subtaskConflicts ? ` · ${subtaskConflicts.length.toString()} sub-answer conflict(s)` : "") +
      (subtaskRedundancies ? ` · ${subtaskRedundancies.length.toString()} redundant sub-answer(s)` : "") +
      (reasoningActionGaps ? ` · ${reasoningActionGaps.length.toString()} step(s) ignored upstream` : ""),
    subtasks,
    truncated,
    ...(synthesisIncomplete ? { synthesisIncomplete } : {}),
    ...(subtaskConflicts ? { subtaskConflicts } : {}),
    ...(subtaskRedundancies ? { subtaskRedundancies } : {}),
    ...(reasoningActionGaps ? { reasoningActionGaps } : {})
  };
}
