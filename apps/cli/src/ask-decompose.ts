import type { AgentRunInput } from "@muse/agent-core";
import type { ToolExposureAuthority } from "@muse/policy";
import { detectSubtaskConflicts, detectSubtaskRedundancies, resolveSubAgentToolBudget, runLeadWorkerTask, verifySynthesisCoverage, type LeadWorkerDeps, type SubtaskExecution } from "@muse/multi-agent";
import { answerIsRefusal } from "@muse/recall";
import type { JsonObject } from "@muse/shared";

interface AskGroundingSource {
  readonly source: string;
  readonly text: string;
}

export interface AskAgentRunResult {
  readonly response: { readonly output?: string };
  readonly toolsUsed?: readonly string[];
  readonly groundingSources?: readonly AskGroundingSource[];
}

interface AskAgentRunner {
  run(input: AgentRunInput): Promise<AskAgentRunResult>;
}

export interface DecomposedAskArgs {
  readonly runner: AskAgentRunner;
  readonly query: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly metadata: JsonObject;
  readonly toolExposureAuthority?: ToolExposureAuthority;
  /** Embed fn for the fan-in cross-subtask conflict check. Omitted ⇒ no conflict check. */
  readonly embed?: (text: string) => Promise<readonly number[]>;
}

export interface DecomposedAskResult {
  readonly answer: string;
  readonly groundingSources: readonly AskGroundingSource[];
  readonly toolsUsed: readonly string[];
  readonly decomposed: boolean;
  readonly subtaskCount: number;
  readonly reason: string;
  /** `true` when the sub-task list was capped at MAX_SUBTASKS (the answer is PARTIAL). */
  readonly truncated: boolean;
  /** Completed sub-tasks the fan-in verifier judged dropped from the synthesis (G1). */
  readonly synthesisIncomplete?: readonly string[];
  /** Captions for completed sub-answers that CONTRADICT each other (J2 fan-in conflict). */
  readonly subtaskConflicts?: readonly string[];
  /** Captions for completed sub-answers that are near-identical — a worker did duplicate work (MAST step-repetition). */
  readonly subtaskRedundancies?: readonly string[];
  /** Captions for sequenced steps that ignored the upstream result they were handed (MAST FM-2.6 reasoning-action mismatch). */
  readonly reasoningActionGaps?: readonly string[];
}

/**
 * `runDecomposedAgentAsk`'s `answer` is `""` when every sub-task failed to
 * ground (the seam's documented contract — see the "returns an empty answer
 * when every sub-task fails" test below; the seam itself stays fail-closed
 * and unchanged). The CALLER must never print that blank string verbatim: an
 * empty string satisfies neither a grounded answer NOR `answerIsRefusal`
 * (which matches on marker phrases, so `""` matches none), so a decomposed
 * all-failed `muse ask --with-tools` would silently print nothing AND skip
 * every honest-refusal UX downstream (warm-close, opt-in-source tip,
 * sourceCheck all branch on `answerIsRefusal`). This turns the blank into an
 * explicit, marker-bearing refusal so those all fire correctly.
 */
export function decomposedAnswerOrRefusal(answer: string): string {
  if (answer.trim().length > 0) return answer;
  return "I'm not sure — none of the sub-tasks for this question could be answered from your grounded sources.";
}

const PLANNER_SYSTEM_PROMPT =
  "사용자 요청을 독립적으로 처리할 수 있는 하위 작업으로 나눠라. " +
  "각 하위 작업을 한 줄에 하나씩, 번호나 불릿 없이 출력하라. " +
  "더 나눌 수 없으면 원래 요청을 한 줄로만 출력하라.";

/**
 * Strip a leading list marker (a bullet, or a number followed by `.`/`)`) — but ONLY
 * a real marker, not a digit that BEGINS the content. The old greedy class
 * `^[-*•\d.)\s]+` ate the `1` from `1분기 정리` (Q1) → `분기 정리`, collapsing three
 * DISTINCT quarters into identical text (a manufactured duplicate the dedup gate then
 * had to absorb). The precise marker `(?:[-*•]|\d+[.)])` preserves `1분기`.
 */
export function parsePlannerLines(output: string): readonly string[] {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/u, "").trim())
    .filter(Boolean);
}

function buildSynthesisPrompt(query: string, completed: readonly SubtaskExecution[]): string {
  const parts = completed.map((e, i) => `[${i + 1}] ${e.subtask.text}\n${e.output ?? ""}`).join("\n\n");
  return (
    `사용자 요청: ${query}\n\n` +
    `아래는 하위 작업별 결과입니다. 이를 하나의 답으로 종합하되, ` +
    `각 결과에 없는 사실은 새로 만들어 넣지 마세요.\n\n${parts}`
  );
}

function metadataWithoutToolAuthority(metadata: JsonObject, maxTools: number | undefined): JsonObject {
  const {
    allowedToolNames: _allowedToolNames,
    approvalReceipt: _approvalReceipt,
    capabilityProfile: _capabilityProfile,
    forbiddenToolNames: _forbiddenToolNames,
    localMode: _localMode,
    profileId: _profileId,
    toolApprovalGate: _toolApprovalGate,
    toolExposureAuthority: _toolExposureAuthority,
    ...safeMetadata
  } = metadata;
  return {
    ...safeMetadata,
    ...(maxTools === undefined ? {} : { maxTools })
  };
}

/**
 * Runs a complex `muse ask` request as a lead-worker fan-out: each sub-task
 * runs as its OWN agent run (clean context — only its sub-task text, never the
 * siblings' output), then a final synthesis run combines them. Every sub-task
 * AND the synthesis contribute their `groundingSources` to a merged set, so the
 * caller's existing citation gate verifies the synthesized answer against the
 * real evidence the workers actually retrieved — a fabricated citation in the
 * combined answer is still stripped. A simple request bypasses all of this and
 * runs once (handled inside `runLeadWorkerTask`). Sequential by design: one
 * local GPU serializes the runs, and the value here is context isolation, not
 * parallel speed.
 */
export async function runDecomposedAgentAsk(args: DecomposedAskArgs): Promise<DecomposedAskResult> {
  // Keep every run's sources by name (text preserved), but DON'T merge eagerly — a
  // sub-task's sources only become evidence if that sub-task COMPLETED (status-linked
  // via SubtaskExecution.sources). An ungrounded/failed sub-task's retrieved sources
  // must not grade the final answer (a fabricated citation on a source no surviving
  // sub-task used). The synthesis run's own sources are allowed too.
  const sourceByName = new Map<string, AskGroundingSource>();
  const mergedTools = new Set<string>();
  let synthesisSourceNames: readonly string[] = [];
  const toolExposureAuthority = args.toolExposureAuthority ?? null;

  const runSubtaskMessage = async (
    userContent: string,
    maxToolsOverride?: number
  ): Promise<AskAgentRunResult> => {
    const metadata = metadataWithoutToolAuthority(args.metadata, maxToolsOverride);
    const result = await args.runner.run({
      messages: [
        { content: args.systemPrompt, role: "system" },
        { content: userContent, role: "user" }
      ],
      metadata,
      model: args.model,
      toolExposureAuthority
    } satisfies AgentRunInput);
    for (const s of result.groundingSources ?? []) sourceByName.set(s.source, s);
    for (const t of result.toolsUsed ?? []) mergedTools.add(t);
    return result;
  };

  const deps: LeadWorkerDeps = {
    // For a SEQUENCED split the engine passes the prior steps' completed outputs;
    // prepend them so this worker can act on the upstream RESULT (an independent
    // list passes nothing → the worker stays isolated).
    execute: async (subtask, priorContext) => {
      const userContent = priorContext && priorContext.length > 0
        ? `이전 단계 결과:\n${priorContext.join("\n\n")}\n\n이어서 처리: ${subtask.text}`
        : subtask.text;
      // A worker handles ONE focused sub-task — give it its own smaller budget so a
      // fan-out of N workers doesn't each spend the full parent cap (N× the intended
      // limit). Synthesis/planner below stay on the parent budget — they're lead-level
      // fan-in/planning, not fanned-out workers.
      const parentMaxTools = typeof args.metadata.maxTools === "number" ? args.metadata.maxTools : undefined;
      const result = await runSubtaskMessage(userContent, resolveSubAgentToolBudget(parentMaxTools));
      return {
        output: result.response.output ?? "",
        sources: (result.groundingSources ?? []).map((s) => s.source)
      };
    },
    // A worker that refuses ("I'm not sure", "모르겠다") is NOT a grounded
    // result — fail-close it so the lead never folds an abstention into the
    // synthesized answer as if it were an answer. (Blank output is already
    // fail-closed inside the engine.)
    groundingGate: (output) => !answerIsRefusal(output.output),
    // Model planner for a broad-scope ask with no literal structure to split
    // ("내 노트 전부 … 보고서"): the engine calls this only when deterministic
    // decomposition yields a single task, and uses it only if it returns 2+.
    planner: async (request) => {
      const result = await args.runner.run({
        messages: [
          { content: PLANNER_SYSTEM_PROMPT, role: "system" },
          { content: request, role: "user" }
        ],
        metadata: metadataWithoutToolAuthority(args.metadata, undefined),
        model: args.model,
        toolExposureAuthority
      } satisfies AgentRunInput);
      return parsePlannerLines(result.response.output ?? "");
    },
    synthesize: async (query, executions) => {
      const completed = executions.filter((e) => e.status === "completed");
      if (completed.length === 0) return "";
      if (completed.length === 1) return completed[0]?.output ?? "";
      const result = await runSubtaskMessage(buildSynthesisPrompt(query, completed));
      synthesisSourceNames = (result.groundingSources ?? []).map((s) => s.source);
      return result.response.output ?? "";
    },
    // Fan-in objective-satisfaction (maker != judge): deterministically flag a
    // completed sub-task the synthesis silently dropped, so an incomplete answer
    // surfaces instead of being returned as confident-complete.
    verifySynthesis: (_request, finalAnswer, executions) => verifySynthesisCoverage(finalAnswer, executions),
    // Fan-in cross-subtask CONFLICT: flag two completed sub-answers that contradict
    // each other (the grounding edge on the fan-out) so an internally-inconsistent
    // answer surfaces. Only when an embed is supplied.
    ...(args.embed ? { detectConflicts: (executions: readonly SubtaskExecution[]) => detectSubtaskConflicts(executions, args.embed!) } : {}),
    // Fan-in step-repetition: flag two completed sub-answers that are near-identical (a
    // worker duplicated another's work). Only when an embed is supplied (mirrors conflicts).
    ...(args.embed ? { detectRedundancies: (executions: readonly SubtaskExecution[]) => detectSubtaskRedundancies(executions, args.embed!) } : {})
  };

  const leadResult = await runLeadWorkerTask(args.query, deps);

  // Source-leak fix: only sources a COMPLETED sub-task (or the synthesis run) used
  // become the evidence the answer is graded on / shown as receipts. An
  // ungrounded/failed sub-task's retrieved sources are dropped here (its output was
  // already withheld by the engine — now its sources are too).
  const allowedSourceNames = new Set<string>([
    ...leadResult.executions.filter((e) => e.status === "completed").flatMap((e) => e.sources ?? []),
    ...synthesisSourceNames
  ]);
  const mergedSources = [...allowedSourceNames]
    .map((name) => sourceByName.get(name))
    .filter((s): s is AskGroundingSource => s !== undefined);

  return {
    answer: leadResult.finalAnswer,
    decomposed: leadResult.decomposed,
    groundingSources: mergedSources,
    reason: leadResult.reason,
    subtaskCount: leadResult.subtasks.length,
    truncated: leadResult.truncated,
    ...(leadResult.synthesisIncomplete ? { synthesisIncomplete: leadResult.synthesisIncomplete } : {}),
    ...(leadResult.subtaskConflicts ? { subtaskConflicts: leadResult.subtaskConflicts } : {}),
    ...(leadResult.subtaskRedundancies ? { subtaskRedundancies: leadResult.subtaskRedundancies } : {}),
    ...(leadResult.reasoningActionGaps ? { reasoningActionGaps: leadResult.reasoningActionGaps } : {}),
    toolsUsed: [...mergedTools]
  };
}
