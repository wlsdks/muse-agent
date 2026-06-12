import type { AgentSpecResolution } from "@muse/agent-specs";
import type { ModelMessage, ModelResponse, ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";
import { normalizeSourceUrl } from "./internals.js";
import type { PlanStep, StepExecutionResult } from "./plan-execute.js";
import { toAgentSpecRunReport } from "./runtime-helpers.js";
import { extractToolInsights, extractVerifiedSources } from "./tool-output-evidence.js";
import type { AgentContextWindowReport, AgentRunResult, VerifiedSource } from "./types.js";

/**
 * Internal AgentRuntime types and helpers.
 *
 * These are NOT part of the public package surface — consumers should never
 * import from this file directly. They live here so the runtime monolith does
 * not have to inline its own data shapes alongside the public AgentRuntime
 * class.
 */

export interface ExecutedToolResult {
  readonly toolCall: ModelToolCall;
  readonly result: ToolExecutionResult;
}

export interface ModelLoopExecution {
  readonly finalResponse: ModelResponse;
  readonly intermediateMessages: readonly ModelMessage[];
  readonly toolResults: readonly ExecutedToolResult[];
  readonly toolsUsed: readonly string[];
}

export interface StreamedModelTurn {
  readonly response: ModelResponse;
}

export interface StreamExecutionOptions {
  readonly forwardTextDeltas: boolean;
}

export interface PlanExecuteStepRecord {
  readonly step: PlanStep;
  readonly executed: ExecutedToolResult;
  readonly stepResult: StepExecutionResult;
}

/**
 * Builds the synthetic `ExecutedToolResult` we hand back when a tool call is
 * rejected before reaching the executor (max-tool-call cap, unexposed tool,
 * missing executor, blocked validation, etc.). The synthesised result keeps
 * the ToolCall id/name pair so the runtime's history sink and message-pair
 * integrity checks see a consistent shape.
 */
export function blockedToolResult(toolCall: ModelToolCall, output: string): ExecutedToolResult {
  return {
    result: {
      id: toolCall.id,
      name: toolCall.name,
      output,
      status: "blocked"
    },
    toolCall
  };
}

/**
 * Renders the executed Plan-Execute steps as the assistant + tool message
 * pair the synthesis-time prompt expects. The assistant message carries the
 * raw plan JSON plus every tool call (so the message pair is intact); each
 * tool message carries its result keyed by the assistant's tool call id.
 */
export function planExecuteIntermediateMessages(
  plan: readonly PlanStep[],
  executed: readonly PlanExecuteStepRecord[]
): readonly ModelMessage[] {
  const planSummary: ModelMessage = {
    content: JSON.stringify(plan),
    role: "assistant",
    toolCalls: executed.map((entry) => entry.executed.toolCall)
  };
  const toolMessages: ModelMessage[] = executed.map((entry) => ({
    content: entry.executed.result.output,
    name: entry.executed.toolCall.name,
    role: "tool",
    toolCallId: entry.executed.toolCall.id
  }));
  return [planSummary, ...toolMessages];
}

/** Internal evidence shape passed into the response-filter stage. */
export interface ResponseFilterEvidence {
  readonly toolInsights: readonly string[];
  readonly toolsUsed: readonly string[];
  readonly verifiedSources: readonly VerifiedSource[];
}

/**
 * Walks the runtime's executed tool results and extracts (a) the verified
 * source URLs (de-duplicated by canonical URL) and (b) the short Korean
 * insights/count summaries the tool-output-evidence module produces. The
 * combined block is what response filters consume to render a
 * `<sources>` block, decide whether the response over-claims results, etc.
 */
export function responseFilterEvidenceFromExecution(execution: ModelLoopExecution): ResponseFilterEvidence {
  const sourceMap = new Map<string, VerifiedSource>();
  const insightSet = new Set<string>();

  for (const executed of execution.toolResults) {
    for (const source of extractVerifiedSources(executed.result.name, executed.result.output)) {
      const key = normalizeSourceUrl(source.url);

      if (!sourceMap.has(key)) {
        sourceMap.set(key, source);
      }
    }

    for (const insight of extractToolInsights(executed.result.output)) {
      insightSet.add(insight);
    }
  }

  return {
    toolInsights: [...insightSet],
    toolsUsed: execution.toolsUsed,
    verifiedSources: [...sourceMap.values()]
  };
}

/**
 * Builds the public AgentRunResult from the runtime's internal state. The
 * shape is conditional: cache flag, tools-used array, agentSpec report, and
 * contextWindow are all optional so a small no-tools no-cache no-spec run
 * doesn't carry empty fields.
 */
/** Cap per-tool evidence text so a large web page can't bloat the reverify prompt. */
const GROUNDING_SOURCE_TEXT_CAP = 4000;

/**
 * The text outputs of the tools the agent actually ran, as grounding evidence
 * `{ source: toolName, text: output }`. A caller's output-side grounding verdict
 * scores the answer against THIS — the evidence the agent was shown — so a
 * web-grounded `--with-tools` answer isn't false-flagged against a notes-only
 * set. Empty outputs (an actuator's "sent", a no-results lookup) and
 * non-completed (blocked/failed) results — whose output is an error string, not
 * evidence — are skipped.
 */
/**
 * What ONE executed tool contributes as grounding evidence, or `undefined` if it
 * contributed none. Single source of truth shared by the non-streaming run path
 * ({@link groundingSourcesFromToolResults}) and the streamed `tool-result` event,
 * so "what counts as tool grounding" cannot diverge between surfaces. Only a
 * COMPLETED tool with non-empty text counts — a blocked/failed result's output is
 * an error string (not evidence), and an empty output is an actuator's "sent".
 */
export function groundingSourceFromExecuted(
  executed: ExecutedToolResult
): { readonly source: string; readonly text: string } | undefined {
  if (executed.result.status !== "completed") {
    return undefined;
  }
  const raw = typeof executed.result.output === "string" ? executed.result.output.trim() : "";
  if (raw.length === 0) {
    return undefined;
  }
  return { source: executed.result.name, text: raw.length > GROUNDING_SOURCE_TEXT_CAP ? raw.slice(0, GROUNDING_SOURCE_TEXT_CAP) : raw };
}

function groundingSourcesFromToolResults(
  toolResults: readonly ExecutedToolResult[]
): readonly { readonly source: string; readonly text: string }[] {
  const out: { source: string; text: string }[] = [];
  for (const executed of toolResults) {
    const source = groundingSourceFromExecuted(executed);
    if (source) {
      out.push(source);
    }
  }
  return out;
}

export function createRunResult(
  runId: string,
  response: ModelResponse,
  contextWindow: AgentContextWindowReport | undefined,
  agentSpec: AgentSpecResolution | undefined,
  execution: {
    readonly fromCache?: boolean;
    readonly toolsUsed?: readonly string[];
    readonly toolResults?: readonly ExecutedToolResult[];
    readonly inboxSources?: readonly { readonly source: string; readonly text: string }[];
  } = {}
): AgentRunResult {
  const agentSpecReport = agentSpec ? toAgentSpecRunReport(agentSpec) : undefined;
  const groundingSources = [
    ...(execution.toolResults ? groundingSourcesFromToolResults(execution.toolResults) : []),
    ...(execution.inboxSources ?? [])
  ];
  const base = {
    ...(execution.fromCache ? { fromCache: true } : {}),
    ...(execution.toolsUsed && execution.toolsUsed.length > 0 ? { toolsUsed: execution.toolsUsed } : {}),
    ...(groundingSources.length > 0 ? { groundingSources } : {}),
    response,
    runId
  };

  if (!contextWindow) {
    return agentSpecReport ? { ...base, agentSpec: agentSpecReport } : base;
  }

  return agentSpecReport
    ? { ...base, agentSpec: agentSpecReport, contextWindow }
    : { ...base, contextWindow };
}
