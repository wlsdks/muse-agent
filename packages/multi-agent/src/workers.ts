import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import type { ModelMessage } from "@muse/model";

import { runCascade } from "./cascade-run.js";

export interface AgentWorker {
  readonly id: string;
  readonly description: string;
  /**
   * Optional per-worker model override. When set, the orchestrator
   * dispatches this worker with `input.model` replaced by this value,
   * so a fast model can take a lookup while a high-capability model
   * takes the reasoning in the same run. Absent ⇒ the worker runs on
   * the run-default `input.model` (single-model behaviour unchanged).
   */
  readonly model?: string;
  /** Optional child allowlist. Undefined inherits the parent ceiling; [] denies all tools. */
  readonly toolNames?: readonly string[];
  canHandle(input: AgentRunInput): number;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export class NoAgentWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAgentWorkerError";
  }
}

export class RuntimeAgentWorker implements AgentWorker {
  constructor(
    readonly id: string,
    readonly description: string,
    private readonly runtime: AgentRuntime,
    private readonly matcher: (input: AgentRunInput) => number,
    readonly model?: string,
    readonly toolNames?: readonly string[]
  ) {}

  canHandle(input: AgentRunInput): number {
    return this.matcher(input);
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.runtime.run(input);
  }
}

export interface RuntimeAgentWorkerSpec {
  readonly description: string;
  readonly id: string;
  /** Stable persisted spec id; omitted for an ad-hoc runtime worker. */
  readonly specId?: string;
  readonly systemPrompt?: string;
  /** Preserve omission versus an explicit empty AgentSpec allowlist. */
  readonly toolNames?: readonly string[];
}

export interface RuntimeAgentWorkerOptions {
  readonly model?: string;
  readonly runtime: AgentRuntime;
  readonly spec: RuntimeAgentWorkerSpec;
}

function prepareRuntimeWorkerInput(
  input: AgentRunInput,
  spec: RuntimeAgentWorkerSpec,
  overrides: Partial<Pick<AgentRunInput, "logprobs" | "model">> = {}
): AgentRunInput {
  return {
    ...input,
    ...overrides,
    messages: spec.systemPrompt ? prependSystem(input.messages, spec.systemPrompt) : input.messages,
    metadata: {
      ...(input.metadata ?? {}),
      ...(spec.specId ? { agentSpecId: spec.specId } : {}),
      selectedAgentId: spec.id
    }
  };
}

/**
 * Build a delegation worker over Muse's ONE AgentRuntime. The worker carries a
 * model id only as a routing hint; the orchestrator places it on
 * `AgentRunInput.model`, and AgentRuntime's shared model registry resolves it.
 */
export function createRuntimeAgentWorker(options: RuntimeAgentWorkerOptions): AgentWorker {
  const { model, runtime, spec } = options;
  return {
    canHandle: () => 1,
    description: spec.description,
    id: spec.id,
    ...(model ? { model } : {}),
    ...(spec.toolNames !== undefined ? { toolNames: [...spec.toolNames] } : {}),
    run: (input) => runtime.run(prepareRuntimeWorkerInput(input, spec))
  };
}

export interface CascadeRuntimeAgentWorkerOptions extends Omit<RuntimeAgentWorkerOptions, "model"> {
  readonly confidenceOf: (result: AgentRunResult) => number | undefined;
  readonly fastModel: string;
  readonly heavyModel: string;
}

/** Bounded fast → heavy delegation over the same shared AgentRuntime. */
export function createCascadeRuntimeAgentWorker(options: CascadeRuntimeAgentWorkerOptions): AgentWorker {
  const { confidenceOf, fastModel, heavyModel, runtime, spec } = options;
  return {
    canHandle: () => 1,
    description: spec.description,
    id: spec.id,
    model: fastModel,
    ...(spec.toolNames !== undefined ? { toolNames: [...spec.toolNames] } : {}),
    async run(input) {
      const baseInput = prepareRuntimeWorkerInput(input, spec, { logprobs: true });
      const outcome = await runCascade<AgentRunResult>({
        confidenceOf,
        fast: fastModel,
        heavy: heavyModel,
        run: (model) => runtime.run({ ...baseInput, model })
      });
      return outcome.result;
    }
  };
}

export class RuleBasedAgentWorker implements AgentWorker {
  private readonly keywords: readonly string[];

  constructor(
    readonly id: string,
    readonly description: string,
    keywords: readonly string[],
    private readonly handler: (input: AgentRunInput) => Promise<AgentRunResult> | AgentRunResult
  ) {
    // Drop empty / whitespace-only keywords at construction. `text.includes("")`
    // is universally true, so a single blank slip would otherwise score confidence
    // > 0 against every input — silently inflating dispatch confidence.
    // Dedupe too — a duplicate keyword counts twice in the denominator AND the
    // numerator (when matched), shifting the ratio away from the operator's
    // intent (e.g. ["foo","foo","bar"] vs. text "foo" → 2/3 instead of 1/2).
    this.keywords = [...new Set(
      keywords
        .map((keyword) => keyword.toLowerCase().trim())
        .filter((keyword) => keyword.length > 0)
    )];
  }

  canHandle(input: AgentRunInput): number {
    const text = joinMessages(input.messages).toLowerCase();
    const matched = this.keywords.filter((keyword) => containsKeywordWithBoundary(text, keyword)).length;
    return this.keywords.length === 0 ? 0 : matched / this.keywords.length;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.handler(input);
  }
}

export function joinMessages(messages: readonly ModelMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

function prependSystem(messages: readonly ModelMessage[], systemPrompt: string): readonly ModelMessage[] {
  const [first, ...rest] = messages;
  if (first?.role === "system") {
    return [{ content: `${systemPrompt}\n\n${first.content}`, role: "system" }, ...rest];
  }
  return [{ content: systemPrompt, role: "system" }, ...messages];
}

// ASCII/Latin keywords must match on word boundaries — a raw substring
// lets a short keyword ("ai", "go", "db", "rag") fire inside unrelated
// words ("email", "ago", "fragment") and silently inflate dispatch
// confidence. CJK keywords keep substring matching: Korean
// agglutinates particles without spaces ("우선순위" inside
// "우선순위를"), where a word-boundary rule would wrongly miss the
// stem. Same posture as packages/policy/src/topic-drift.ts.
function containsKeywordWithBoundary(haystack: string, keyword: string): boolean {
  if (keyword.length === 0) {
    return false;
  }
  if (hasCjkCodePoint(keyword)) {
    return haystack.includes(keyword);
  }
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(haystack);
}

function hasCjkCodePoint(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3040 && cp <= 0x309f) ||
      (cp >= 0x30a0 && cp <= 0x30ff)
    ) {
      return true;
    }
  }
  return false;
}
