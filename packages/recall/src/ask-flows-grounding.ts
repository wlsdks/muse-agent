/**
 * "What automations do I have?" grounding for `muse ask` — the user's own
 * Builder flows / scheduled jobs (`@muse/scheduler`'s file store), lifted out
 * as the 13th optional grounding source. Reads the FILE store directly (no
 * cycle: `@muse/scheduler` does not depend on `@muse/recall`), gated by its
 * flag (default-on), fail-soft — a missing/corrupt store contributes no
 * block. Selection is deterministic (no embed call): an automation-INTENT
 * keyword hit ("what automations do I have?") enumerates every job; a
 * name/description/tag content-token overlap hit ("when does my morning
 * briefing run?") ranks by that overlap. See `buildFlowContextBlock` in
 * context-blocks.ts for the SECRET WHITELIST the rendered block is bound to.
 */

import { lexicalTokens } from "@muse/agent-core";
import { FileScheduledJobStore, type ScheduledJob } from "@muse/scheduler";

import { buildFlowContextBlock } from "./context-blocks.js";

export interface FlowsGrounding {
  readonly matchedFlows: readonly ScheduledJob[];
  readonly flowsBlock: string;
}

const MAX_MATCHED_FLOWS = 12;

// KO tokens routinely arrive with a grammatical particle glued on
// ("자동화를", "스케줄잡") because `lexicalTokens` splits on script
// boundaries, not on Korean word boundaries — an EXACT `Set.has` miss would
// falsely treat "자동화를 보여줘" as having no automation intent. A stem-PREFIX
// check catches the particle-attached form without over-matching; English has
// no such attachment, so it stays an exact-word set (a prefix check there
// would also match unrelated words like "flower").
const AUTOMATION_INTENT_KO_STEMS: readonly string[] = ["자동", "흐름", "스케줄", "예약", "브리핑", "빌더", "웹훅", "트리거"];
const AUTOMATION_INTENT_EN_WORDS: ReadonlySet<string> = new Set([
  "automation", "automations", "flow", "flows", "schedule", "schedules", "scheduled", "scheduling",
  "cron", "webhook", "webhooks", "briefing", "briefings", "builder", "builders",
  "trigger", "triggers", "job", "jobs"
]);

/** Whether the query expresses "what automations do I have?" intent — an
 * ENUMERATION request rather than a question about one specific flow. Pure. */
function hasAutomationIntent(queryTokens: ReadonlySet<string>): boolean {
  for (const token of queryTokens) {
    if (AUTOMATION_INTENT_EN_WORDS.has(token)) {
      return true;
    }
    if (AUTOMATION_INTENT_KO_STEMS.some((stem) => token.startsWith(stem))) {
      return true;
    }
  }
  return false;
}

/** Content-token overlap between the query and one job's name/description/tags
 * — the same "which of MY items is this about" scoring `contactMatchScore` and
 * `selectGroundingActions` use. 0 ⇒ not injected. */
function flowMatchScore(job: ScheduledJob, queryTokens: ReadonlySet<string>): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  const hay = new Set<string>();
  const add = (text: string | undefined): void => {
    if (text) {
      for (const tok of lexicalTokens(text)) {
        hay.add(tok);
      }
    }
  };
  add(job.name);
  add(job.description);
  for (const tag of job.tags) {
    add(tag);
  }
  let score = 0;
  for (const tok of queryTokens) {
    if (hay.has(tok)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Select the jobs relevant to this turn. An automation-ENUMERATION intent hit
 * ("what automations do I have?") returns every job (enabled first, cap
 * `max`) — the user is asking for the whole list, not one flow. Otherwise a
 * name/description/tag overlap hit ("when does my morning briefing run?")
 * ranks by that overlap score. Neither hits ⇒ empty (no fabricated listing on
 * an unrelated question). Pure + deterministic (no embed).
 */
export function selectFlows(jobs: readonly ScheduledJob[], query: string, max = MAX_MATCHED_FLOWS): readonly ScheduledJob[] {
  const queryTokens = lexicalTokens(query);
  if (queryTokens.size === 0) {
    return [];
  }
  if (hasAutomationIntent(queryTokens)) {
    return [...jobs]
      .sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1))
      .slice(0, max);
  }
  return jobs
    .map((job) => ({ job, score: flowMatchScore(job, queryTokens) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((scored) => scored.job);
}

export async function buildFlowsGroundingCore(params: {
  readonly query: string;
  readonly flows: boolean;
  /** Resolved scheduled-jobs store file (the caller owns env/path resolution). */
  readonly flowsFile: string;
}): Promise<FlowsGrounding> {
  const { query, flows, flowsFile } = params;
  let matchedFlows: readonly ScheduledJob[] = [];
  if (flows) {
    try {
      const all = await new FileScheduledJobStore({ file: flowsFile }).list();
      matchedFlows = selectFlows(all, query);
    } catch {
      // store missing / corrupt — silently skip (fail-soft)
    }
  }
  const flowsBlock = buildFlowContextBlock(matchedFlows);
  return { flowsBlock, matchedFlows };
}
