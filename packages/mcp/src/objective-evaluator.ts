/**
 * Concrete production wiring for `runDueObjectives`'s injected
 * `evaluate` / `act` / `escalate` seams (P9-b2):
 *
 *  - `createModelObjectiveEvaluator` asks the model whether a
 *    standing objective's condition currently holds and parses a
 *    strict JSON verdict. Conservative safe default: anything that
 *    is not an unambiguous `met` / `unmeetable` ⇒ `unmet` (retry
 *    next tick) — never crash, never a false `met`, never a false
 *    `unmeetable`.
 *  - `createMessagingObjectiveActuator` delivers the met /
 *    escalated notice over the messaging registry (zero-LLM,
 *    reuses the proven retry-send path).
 */

import type { MessagingProviderRegistry } from "@muse/messaging";

import { sendWithRetry } from "./messaging-retry.js";
import type { ObjectiveEvaluation } from "./objective-evaluation-loop.js";
import type { StandingObjective } from "./personal-objectives-store.js";
import type { ProactiveModelProviderLike } from "./proactive-notice-loop.js";

const SYSTEM_PROMPT =
  `You decide whether a standing objective's condition is currently `
  + `satisfied, given only the objective text and the current time. `
  + `Respond with ONE JSON object and nothing else:\n`
  + `{"outcome":"met"|"unmet"|"unmeetable","reason":"<short, only for unmeetable>"}\n`
  + `- met: the condition is now true.\n`
  + `- unmet: not true yet, but it could still become true later.\n`
  + `- unmeetable: it can never be satisfied (the thing it depends `
  + `on no longer exists / is logically impossible).\n`
  + `When unsure, answer "unmet". No prose, no markdown.`;

export interface ModelObjectiveEvaluatorOptions {
  readonly modelProvider: ProactiveModelProviderLike;
  readonly model: string;
  readonly now?: () => Date;
}

export function createModelObjectiveEvaluator(
  options: ModelObjectiveEvaluatorOptions
): (objective: StandingObjective) => Promise<ObjectiveEvaluation> {
  const now = options.now ?? (() => new Date());
  return async (objective) => {
    let output: string;
    try {
      const result = await options.modelProvider.generate({
        maxOutputTokens: 120,
        messages: [
          { content: SYSTEM_PROMPT, role: "system" },
          {
            content:
              `objective (${objective.kind}): ${objective.spec}\n`
              + `now: ${now().toISOString()}`,
            role: "user"
          }
        ],
        model: options.model,
        temperature: 0
      });
      output = result.output;
    } catch {
      // A model/transport error must not crash the tick — defer.
      return { outcome: "unmet" };
    }
    return parseObjectiveVerdict(output);
  };
}

export function parseObjectiveVerdict(raw: string): ObjectiveEvaluation {
  const match = /\{[\s\S]*\}/u.exec(raw);
  if (!match) {
    return { outcome: "unmet" };
  }
  let parsed: { outcome?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(match[0]) as { outcome?: unknown; reason?: unknown };
  } catch {
    return { outcome: "unmet" };
  }
  if (parsed.outcome === "met") {
    return { outcome: "met" };
  }
  if (parsed.outcome === "unmeetable") {
    const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : "model deemed the objective unmeetable";
    return { outcome: "unmeetable", reason };
  }
  return { outcome: "unmet" };
}

export interface MessagingObjectiveActuatorOptions {
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
}

export function createMessagingObjectiveActuator(options: MessagingObjectiveActuatorOptions): {
  readonly act: (objective: StandingObjective) => Promise<void>;
  readonly escalate: (objective: StandingObjective, reason: string) => Promise<void>;
} {
  const send = (text: string): Promise<void> =>
    sendWithRetry(options.registry, options.providerId, { destination: options.destination, text });
  return {
    act: (objective) => send(`✅ Objective met: ${objective.spec}`),
    escalate: (objective, reason) => send(`⚠ Objective needs you: ${objective.spec} — ${reason}`)
  };
}
