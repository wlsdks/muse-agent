/**
 * Autonomous SUBTRACTIVE correction-decay (P43-1 — the self-development daemon's
 * last safe rung). When the user corrects Muse and that correction CONTRADICTS a
 * strategy Muse currently APPLIES (an injected playbook strategy), the daemon —
 * unattended — drops that strategy's reward to the avoid floor so a LATER session
 * stops applying it. This is the half of "a correction in session A changes
 * session B" that is SIGN-SAFE:
 *
 *  - DECAY-ONLY. It NEVER graduates a probation guess and NEVER raises a reward —
 *    graduation stays bound to a positive user act. The worst case of a polarity
 *    error is a recoverable wrongly-avoided strategy (an approval lifts it back),
 *    NOT an autonomous fabrication entering the prompt.
 *  - POLARITY-GATED + FAIL-CLOSED. A strategy decays ONLY on a confident
 *    `contradict` verdict from `classifyCorrectionContradiction` (an LLM judgment,
 *    because topic-overlap can't tell "do X" from "STOP X"); `agree` / `unrelated`
 *    / `uncertain` / a model error all leave the strategy untouched.
 *  - INJECTED-ONLY. It only targets strategies actually steering the agent
 *    (non-probation, non-avoided) — decaying a probation entry is pointless.
 *  - BRAKE-FIRST. A paused learner's bank is frozen (no classification, no decay).
 */

import { classifyCorrectionContradiction, isInjectableStrategy, PLAYBOOK_AVOID_BELOW, type CorrectionPolarity } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";
import { adjustPlaybookReward, isLearningPaused, queryPlaybook } from "@muse/mcp";

export interface CorrectionSignal {
  /** Playbook id of the probation entry this correction was distilled into (for de-dup/logging). */
  readonly id: string;
  /** The raw correction text the user said (the validated classifier input). */
  readonly text: string;
}

export interface DecayContradictedDeps {
  readonly playbookFile: string;
  readonly userId: string;
  readonly model: string;
  readonly modelProvider: Pick<ModelProvider, "generate">;
  /** Recent corrections to test against the injected strategies (this tick's new probation entries). */
  readonly corrections: readonly CorrectionSignal[];
  /** Learning-pause kill switch — paused ⇒ this does nothing (bank frozen). */
  readonly pauseFile?: string;
  /** ≤ this many polarity classifications per tick (the LLM call is the cost). Default 6. */
  readonly maxClassifications?: number;
  /** Test seam — defaults to the real model-backed polarity classifier. */
  readonly classify?: (correction: string, strategy: string) => Promise<CorrectionPolarity>;
  readonly now?: () => Date;
}

export interface DecayedStrategy {
  readonly id: string;
  readonly text: string;
  /** The reward after decay (the avoid floor) — for the felt notice / log. */
  readonly newReward: number;
  /** The correction that contradicted it. */
  readonly correction: string;
}

export async function decayContradictedStrategies(deps: DecayContradictedDeps): Promise<readonly DecayedStrategy[]> {
  if (deps.pauseFile && (await isLearningPaused(deps.pauseFile))) {
    return []; // brake: a paused learner's bank is frozen
  }
  if (deps.corrections.length === 0) {
    return [];
  }
  const classify = deps.classify
    ?? ((correction: string, strategy: string) => classifyCorrectionContradiction(correction, strategy, { model: deps.model, modelProvider: deps.modelProvider }));
  const cap = Math.max(1, deps.maxClassifications ?? 6);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();

  const bank = await queryPlaybook(deps.playbookFile, deps.userId);
  // INJECTED = the strategies actually steering the agent: injectable per
  // agent-core's gate (non-probation, non-avoided, evidence-gated graduation).
  const injected = bank.filter(isInjectableStrategy);
  if (injected.length === 0) {
    return [];
  }

  const decayed: DecayedStrategy[] = [];
  const alreadyDecayed = new Set<string>();
  let used = 0;
  for (const correction of deps.corrections) {
    if (correction.text.trim().length === 0) {
      continue;
    }
    for (const strategy of injected) {
      if (used >= cap) {
        return decayed; // bounded model spend per tick
      }
      if (alreadyDecayed.has(strategy.id)) {
        continue;
      }
      used += 1;
      const verdict = await classify(correction.text, strategy.text);
      if (verdict !== "contradict") {
        continue; // FAIL-CLOSED: agree / unrelated / uncertain ⇒ no decay
      }
      // Drop to the avoid floor → no longer injected (reversible: a positive
      // reinforce lifts it back above the line). DECAY-ONLY — never graduates.
      const newReward = await adjustPlaybookReward(deps.playbookFile, strategy.id, PLAYBOOK_AVOID_BELOW - (strategy.reward ?? 0), nowMs);
      if (newReward !== undefined) {
        alreadyDecayed.add(strategy.id);
        decayed.push({ correction: correction.text, id: strategy.id, newReward, text: strategy.text });
      }
    }
  }
  return decayed;
}
