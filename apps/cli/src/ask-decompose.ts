import type { AgentRunInput } from "@muse/agent-core";
import { detectSubtaskConflicts, runLeadWorkerTask, verifySynthesisCoverage, type LeadWorkerDeps, type SubtaskExecution } from "@muse/multi-agent";
import { answerIsRefusal } from "@muse/recall";
import type { JsonObject } from "@muse/shared";

export interface AskGroundingSource {
  readonly source: string;
  readonly text: string;
}

export interface AskAgentRunResult {
  readonly response: { readonly output?: string };
  readonly toolsUsed?: readonly string[];
  readonly groundingSources?: readonly AskGroundingSource[];
}

export interface AskAgentRunner {
  run(input: AgentRunInput): Promise<AskAgentRunResult>;
}

export interface DecomposedAskArgs {
  readonly runner: AskAgentRunner;
  readonly query: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly metadata: JsonObject;
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
  /** Completed sub-tasks the fan-in verifier judged dropped from the synthesis (G1). */
  readonly synthesisIncomplete?: readonly string[];
  /** Captions for completed sub-answers that CONTRADICT each other (J2 fan-in conflict). */
  readonly subtaskConflicts?: readonly string[];
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
  const mergedSources: AskGroundingSource[] = [];
  const mergedTools = new Set<string>();

  const runSubtaskMessage = async (userContent: string): Promise<AskAgentRunResult> => {
    const result = await args.runner.run({
      messages: [
        { content: args.systemPrompt, role: "system" },
        { content: userContent, role: "user" }
      ],
      metadata: args.metadata,
      model: args.model
    } satisfies AgentRunInput);
    for (const s of result.groundingSources ?? []) mergedSources.push(s);
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
      const result = await runSubtaskMessage(userContent);
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
        metadata: args.metadata,
        model: args.model
      } satisfies AgentRunInput);
      return parsePlannerLines(result.response.output ?? "");
    },
    synthesize: async (query, executions) => {
      const completed = executions.filter((e) => e.status === "completed");
      if (completed.length === 0) return "";
      if (completed.length === 1) return completed[0]?.output ?? "";
      const result = await runSubtaskMessage(buildSynthesisPrompt(query, completed));
      return result.response.output ?? "";
    },
    // Fan-in objective-satisfaction (maker != judge): deterministically flag a
    // completed sub-task the synthesis silently dropped, so an incomplete answer
    // surfaces instead of being returned as confident-complete.
    verifySynthesis: (_request, finalAnswer, executions) => verifySynthesisCoverage(finalAnswer, executions),
    // Fan-in cross-subtask CONFLICT: flag two completed sub-answers that contradict
    // each other (the grounding edge on the fan-out) so an internally-inconsistent
    // answer surfaces. Only when an embed is supplied.
    ...(args.embed ? { detectConflicts: (executions: readonly SubtaskExecution[]) => detectSubtaskConflicts(executions, args.embed!) } : {})
  };

  const leadResult = await runLeadWorkerTask(args.query, deps);

  return {
    answer: leadResult.finalAnswer,
    decomposed: leadResult.decomposed,
    groundingSources: mergedSources,
    reason: leadResult.reason,
    subtaskCount: leadResult.subtasks.length,
    ...(leadResult.synthesisIncomplete ? { synthesisIncomplete: leadResult.synthesisIncomplete } : {}),
    ...(leadResult.subtaskConflicts ? { subtaskConflicts: leadResult.subtaskConflicts } : {}),
    toolsUsed: [...mergedTools]
  };
}
