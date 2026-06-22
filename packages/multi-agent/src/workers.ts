import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import type { ModelMessage } from "@muse/model";

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
    readonly model?: string
  ) {}

  canHandle(input: AgentRunInput): number {
    return this.matcher(input);
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.runtime.run(input);
  }
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

// ASCII/Latin keywords must match on word boundaries — a raw substring
// lets a short keyword ("ai", "go", "db", "rag") fire inside unrelated
// words ("email", "ago", "fragment") and silently inflate dispatch
// confidence. CJK keywords keep substring matching: Korean
// agglutinates particles without spaces ("우선순위" inside
// "우선순위를"), where a word-boundary rule would wrongly miss the
// stem. Same posture as packages/policy/src/topic-drift.ts.
export function containsKeywordWithBoundary(haystack: string, keyword: string): boolean {
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
