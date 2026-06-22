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

import { sendWithRetry } from "@muse/mcp-shared";
import { appendActionLog } from "@muse/stores";
import type { ObjectiveEvaluation } from "./objective-evaluation-loop.js";
import type { StandingObjective } from "@muse/stores";
import { proposeMessageAction } from "@muse/stores";
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

/**
 * Collect every balanced top-level `{…}` span. A balanced scan
 * (not a greedy regex) so `<think>{…}</think> {"outcome":"met"}`
 * yields TWO candidates instead of one over-wide invalid span.
 * String-aware so a `}` inside a JSON string value doesn't close
 * the object early.
 */
function balancedJsonCandidates(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          // Skip the consumed span so a NESTED object is NOT re-extracted as its
          // own candidate — otherwise `{"plan":{"outcome":"met"},"note":"not yet"}`
          // leaks an inner `{"outcome":"met"}` and parseObjectiveVerdict returns a
          // FALSE `met` (an autonomous false completion). Only TOP-LEVEL objects
          // are verdict candidates; a nested-only outcome is ambiguous ⇒ unmet.
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Provider-agnostic, unattended-safe verdict parse. The objectives
 * daemon runs autonomously across 7 model families, so the verdict
 * can arrive fenced (```json…```), reasoning-wrapped
 * (`<think>…</think>`), or with prose either side. Strip the
 * wrappers, scan ALL balanced JSON objects, and take the LAST one
 * that parses with a recognised `outcome` — a model that "thinks"
 * then answers puts the real verdict last. Anything ambiguous ⇒
 * the conservative `unmet` safe default (never crash, never a
 * false `met`/`unmeetable`).
 */
// Replace each complete <think>…</think> block with a space. A global lazy
// regex (`/<think>[\s\S]*?<\/think>/g`) is O(n²) on input with many unclosed
// `<think>` tags — each open triggers a full forward scan that never finds a
// close — which a repetition-degenerate model can produce. This single linear
// pass preserves the regex's behaviour (case-insensitive, unclosed open keeps
// the rest verbatim, non-overlapping pairs).
function stripThinkBlocks(text: string): string {
  const lower = text.toLowerCase();
  let result = "";
  let index = 0;
  for (;;) {
    const open = lower.indexOf("<think>", index);
    if (open < 0) {
      return result + text.slice(index);
    }
    const close = lower.indexOf("</think>", open + "<think>".length);
    if (close < 0) {
      return result + text.slice(index);
    }
    result += `${text.slice(index, open)} `;
    index = close + "</think>".length;
  }
}

export function parseObjectiveVerdict(raw: string): ObjectiveEvaluation {
  const cleaned = stripThinkBlocks(raw)
    .replace(/```[a-zA-Z]*\n?|```/gu, " ");
  let verdict: ObjectiveEvaluation = { outcome: "unmet" };
  for (const candidate of balancedJsonCandidates(cleaned)) {
    let parsed: { outcome?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(candidate) as { outcome?: unknown; reason?: unknown };
    } catch {
      continue;
    }
    if (parsed.outcome === "met") {
      verdict = { outcome: "met" };
    } else if (parsed.outcome === "unmeetable") {
      const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : "model deemed the objective unmeetable";
      verdict = { outcome: "unmeetable", reason };
    } else if (parsed.outcome === "unmet") {
      verdict = { outcome: "unmet" };
    }
  }
  return verdict;
}

export interface MessagingObjectiveActuatorOptions {
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  /**
   * When set, every autonomous objective action the daemon takes
   * is also appended here so it is reviewable (P6 accountability:
   * "every autonomous action produces a rationale-bearing log
   * entry"). Best-effort relative to the just-delivered action — a
   * log-append failure must never crash the daemon, so it is
   * swallowed; the notification itself already succeeded.
   */
  readonly actionLogFile?: string;
  readonly now?: () => Date;
}

export function createMessagingObjectiveActuator(options: MessagingObjectiveActuatorOptions): {
  readonly act: (objective: StandingObjective) => Promise<void>;
  readonly escalate: (objective: StandingObjective, reason: string) => Promise<void>;
} {
  const now = options.now ?? (() => new Date());
  const send = async (text: string): Promise<void> => {
    await sendWithRetry(options.registry, options.providerId, { destination: options.destination, text });
  };
  const record = async (
    objective: StandingObjective,
    what: string,
    detail: string
  ): Promise<void> => {
    if (!options.actionLogFile) {
      return;
    }
    const whenIso = now().toISOString();
    try {
      await appendActionLog(options.actionLogFile, {
        detail,
        id: `act_${objective.id}_${Date.parse(whenIso).toString()}`,
        objectiveId: objective.id,
        result: "performed",
        userId: objective.userId,
        what,
        when: whenIso,
        why: objective.spec
      });
    } catch {
      // accountability is best-effort vs. the delivered action;
      // never crash the unattended daemon over a log write.
    }
  };
  return {
    act: async (objective) => {
      await send(`✅ Objective met: ${objective.spec}`);
      await record(objective, "objective met — user notified", "messaging notice delivered");
    },
    escalate: async (objective, reason) => {
      await send(`⚠ Objective needs you: ${objective.spec} — ${reason}`);
      await record(objective, "objective escalated — user notified", reason);
    }
  };
}

/**
 * Draft-first objective actuator (outbound-safety): instead of sending
 * the "objective met" / escalation message itself, it PROPOSES the
 * message — persisting a pending proposed action the user confirms via
 * `muse propose approve`. Nothing leaves the machine on the daemon's
 * own judgement. Use this when an objective's notification should be
 * reviewed before it goes out (e.g. to a third party).
 */
export function createProposingObjectiveActuator(options: {
  readonly proposedActionsFile: string;
  readonly providerId: string;
  readonly destination: string;
}): {
  readonly act: (objective: StandingObjective) => Promise<void>;
  readonly escalate: (objective: StandingObjective, reason: string) => Promise<void>;
} {
  return {
    act: async (objective) => {
      await proposeMessageAction(options.proposedActionsFile, {
        destination: options.destination,
        providerId: options.providerId,
        reason: `standing objective ${objective.id} met`,
        summary: `Objective met: ${objective.spec}`,
        text: `✅ Objective met: ${objective.spec}`,
        userId: objective.userId
      });
    },
    escalate: async (objective, reason) => {
      await proposeMessageAction(options.proposedActionsFile, {
        destination: options.destination,
        providerId: options.providerId,
        reason,
        summary: `Objective needs you: ${objective.spec}`,
        text: `⚠ Objective needs you: ${objective.spec} — ${reason}`,
        userId: objective.userId
      });
    }
  };
}
