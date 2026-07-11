/**
 * `/orchestrate <prompt>` in chat: a small fixed fan-out (a direct-answer
 * worker + a risk-critic worker, both hitting the SAME provider/model chat
 * already runs) dispatched via `MultiAgentOrchestrator.runBackground` — so a
 * slow local 12B never blocks the calling turn (hermes-parity background
 * fan-out). The consolidated result surfaces through the SAME proactive-item
 * seam `/job` completions already use (`chat-proactive.ts`'s
 * `orchestrationCompletionItems`), one entry per orchestration.
 */

import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import {
  InMemoryBackgroundOrchestrationStore,
  MultiAgentOrchestrator,
  type AgentWorker,
  type BackgroundOrchestrationHandle,
  type BackgroundOrchestrationRecord
} from "@muse/multi-agent";
import type { ModelProvider } from "@muse/model";
import { createRunId } from "@muse/shared";

import { orchestrationCompletionItems, type OrchestrationDoneInput, type ProactiveItem } from "./chat-proactive.js";

interface OrchestrationWorkerPersona {
  readonly id: string;
  readonly systemPrompt: string;
}

/** Fixed, minimal fan-out — two distinct angles on the SAME user request. No
 *  literal text-splitting: each persona is a genuinely distinct sub-agent, the
 *  same "specialist workers on one request" shape the API's default orchestrate
 *  workers (Generalist + Critic) already use. */
export const ORCHESTRATION_WORKER_PERSONAS: readonly OrchestrationWorkerPersona[] = [
  { id: "direct", systemPrompt: "Answer the user's request directly and concisely, in the language they used." },
  {
    id: "critic",
    systemPrompt: "Review the user's request for risks, edge cases, or considerations they might be missing. Be concise — a short bulleted list is fine."
  }
];

export function buildOrchestrationWorker(persona: OrchestrationWorkerPersona, provider: ModelProvider): AgentWorker {
  return {
    canHandle: () => 1,
    description: persona.systemPrompt,
    id: persona.id,
    run: async (input: AgentRunInput): Promise<AgentRunResult> => {
      const response = await provider.generate({
        maxOutputTokens: 400,
        messages: [{ content: persona.systemPrompt, role: "system" }, ...input.messages],
        model: input.model,
        temperature: 0.3
      });
      return { response, runId: input.runId ?? createRunId(persona.id) };
    }
  };
}

/** Pure projection — no @muse/multi-agent-specific rendering elsewhere. Kept
 *  exported for direct unit testing (the "helper level" chat-ink-core convention). */
export function toOrchestrationDoneInput(record: BackgroundOrchestrationRecord): OrchestrationDoneInput {
  return record.status === "completed"
    ? {
        finishedAt: record.finishedAt.toISOString(),
        id: record.orchestrationId,
        status: "completed",
        subtaskCount: record.subtaskCount,
        summary: record.response.output,
        workerIds: record.workerIds
      }
    : {
        finishedAt: record.finishedAt.toISOString(),
        id: record.orchestrationId,
        status: "failed",
        subtaskCount: record.subtaskCount,
        summary: record.error,
        workerIds: record.workerIds
      };
}

export interface ChatOrchestration {
  /** Kicks off the background fan-out and returns immediately — never awaits
   *  a worker. Feedback line: tell the user N sub-agents were dispatched. */
  readonly startOrchestration: (prompt: string) => BackgroundOrchestrationHandle;
  readonly listRecords: () => readonly BackgroundOrchestrationRecord[];
}

export function createChatOrchestration(provider: ModelProvider, model: string): ChatOrchestration {
  const workers = ORCHESTRATION_WORKER_PERSONAS.map((persona) => buildOrchestrationWorker(persona, provider));
  const orchestrator = new MultiAgentOrchestrator({ workers });
  const store = new InMemoryBackgroundOrchestrationStore();

  return {
    listRecords: () => store.list(),
    startOrchestration: (prompt: string) =>
      orchestrator.runBackground({ messages: [{ content: prompt, role: "user" }], model }, { mode: "parallel" }, store)
  };
}

/** Composes `listRecords` + `orchestrationCompletionItems` — the exact shape
 *  `jobCompletions` uses, so the chat tick effect treats them identically. */
export function orchestrationCompletionsFrom(
  records: readonly BackgroundOrchestrationRecord[],
  sinceIso: string
): readonly ProactiveItem[] {
  return orchestrationCompletionItems(records.map(toOrchestrationDoneInput), sinceIso);
}
