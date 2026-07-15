/**
 * Wires the shared behavioural-rule budget (`selectBehaviouralRules`,
 * `@muse/agent-core`) into the real `muse ask` path. Builds ONE combined
 * `BehaviouralRule[]` out of the user's vetoes/preferences/goals
 * (`classifyPreferenceSlots`) and the already-ranked playbook candidates, runs
 * the shared admission gate with the ACTUAL turn query, and returns the
 * admitted subset split back by kind — `buildMusePersona` (vetoes/prefs/goals)
 * and `renderPlaybookSection` (playbook) both render only what survived.
 *
 * This is the module a prior attempt built but never called from production —
 * `computeRuleAdmission` below is what actually reaches the real `muse ask`
 * system prompt, fed the real playbook file and the real turn query.
 */
import {
  admittedRuleKey,
  classifyPreferenceSlots,
  playbookPrefetchTopK,
  rankPlaybookStrategies,
  rankPlaybookStrategiesByRelevance,
  ruleBudget,
  selectBehaviouralRules,
  type BehaviouralRule
} from "@muse/agent-core";
import type { UserMemory } from "@muse/memory";
import type { PlaybookEntry } from "@muse/stores";

export interface AdmittedRules {
  /** Composite `${kind}:${key}` keys admitted this turn — buildMusePersona filters vetoes/prefs/goals against this. */
  readonly admittedRuleKeys: ReadonlySet<string>;
  /** The admitted playbook entries, in admission order (highest composite score first). */
  readonly admittedPlaybook: readonly PlaybookEntry[];
}

export interface ComputedRuleAdmission extends AdmittedRules {
  /** The raw (unranked, unfiltered) playbook entries for this user — callers that need the full set (e.g. a probation-strategy suggestion) reuse this instead of re-fetching. */
  readonly entries: readonly PlaybookEntry[];
}

/**
 * Select which vetoes/preferences/goals/playbook-strategies reach this turn's
 * system prompt, through the SHARED cross-kind budget. `rankedPlaybook` must
 * already be topK-bounded (`playbookPrefetchTopK`) and ordered — this function
 * does not re-rank playbook candidates, only admits/suppresses/budgets them
 * alongside vetoes/prefs/goals.
 */
export async function selectAdmittedRules(
  userMemory: UserMemory | undefined,
  rankedPlaybook: readonly PlaybookEntry[],
  query: string,
  opts: { readonly budget?: number } = {}
): Promise<AdmittedRules> {
  const { plain, vetoes, goals } = classifyPreferenceSlots(userMemory?.preferences ?? {});
  const rules: BehaviouralRule[] = [];
  let index = 0;
  for (const [key, value] of vetoes) {
    rules.push({ index: index++, key: admittedRuleKey("veto", key), kind: "veto", text: value });
  }
  for (const [key, value] of plain) {
    rules.push({ index: index++, key: admittedRuleKey("pref", key), kind: "pref", text: value });
  }
  for (const [key, value] of goals) {
    rules.push({ index: index++, key: admittedRuleKey("goal", key), kind: "goal", text: value });
  }
  for (const candidate of rankedPlaybook) {
    rules.push({
      index: index++,
      key: admittedRuleKey("playbook", candidate.id),
      kind: "playbook",
      text: candidate.text,
      ...(typeof candidate.reward === "number" ? { reward: candidate.reward } : {}),
      ...(candidate.conflictsWith && candidate.conflictsWith.length > 0
        ? { conflictsWith: candidate.conflictsWith.map((id) => admittedRuleKey("playbook", id)) }
        : {})
    });
  }

  const budget = opts.budget ?? ruleBudget(process.env);
  const result = await selectBehaviouralRules(rules, query, { budget });
  const admittedRuleKeys = new Set(result.admitted.map((r) => r.key));
  const byId = new Map(rankedPlaybook.map((e) => [admittedRuleKey("playbook", e.id), e]));
  const admittedPlaybook = result.admitted
    .filter((r) => r.kind === "playbook")
    .map((r) => byId.get(r.key))
    .filter((e): e is PlaybookEntry => e !== undefined);

  return { admittedPlaybook, admittedRuleKeys };
}

/**
 * Full pipeline: fetch this user's playbook, pre-rank it (embed-ranked when
 * `opts.embed` is given — the `MUSE_PLAYBOOK_EMBED_RANK` opt-in path — else
 * the default lexical ranker), then run `selectAdmittedRules` against the
 * ACTUAL turn query. Fail-soft by construction (a queryPlaybook error
 * propagates to the caller's own try/catch, matching the existing playbook
 * block's fail-soft posture in `ask-context-assembly.ts`).
 */
export async function computeRuleAdmission(
  userMemory: UserMemory | undefined,
  userKey: string,
  query: string,
  opts: {
    readonly budget?: number;
    readonly embed?: (text: string) => Promise<readonly number[]>;
    readonly now?: number;
  } = {}
): Promise<ComputedRuleAdmission> {
  const { queryPlaybook } = await import("@muse/stores");
  const { resolvePlaybookFile } = await import("@muse/autoconfigure");
  const entries = await queryPlaybook(resolvePlaybookFile(process.env as Record<string, string | undefined>), userKey);
  const topK = playbookPrefetchTopK(process.env);
  const rankedStrategies = opts.embed
    ? await rankPlaybookStrategiesByRelevance(entries, query, opts.embed, topK === undefined ? undefined : { topK }, opts.now ?? Date.now())
    : rankPlaybookStrategies(entries, query, topK === undefined ? undefined : { topK });
  // rankPlaybookStrategies(ByRelevance) returns PlaybookStrategy-shaped objects
  // (the id survives the projection); map back to the full PlaybookEntry by id
  // so downstream admission sees `conflictsWith` too, preserving ranked order.
  const rankedEntries = rankedStrategies
    .map((s) => entries.find((e) => e.id === s.id))
    .filter((e): e is PlaybookEntry => e !== undefined);
  const { admittedPlaybook, admittedRuleKeys } = await selectAdmittedRules(userMemory, rankedEntries, query, opts);
  return { admittedPlaybook, admittedRuleKeys, entries };
}
