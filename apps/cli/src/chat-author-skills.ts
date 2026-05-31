/**
 * Session-end skill authoring. Reads the just-finished session, detects
 * procedural user corrections, asks the local model to generalise each into
 * a reusable SKILL.md, and writes it execute-gated to the authored skills
 * dir (picked up next session). Mirrors distillSessionCorrections: injectable
 * I/O, fail-soft, typed skip reason. The two are complementary — distillation
 * records a one-line playbook PREFERENCE; this records a multi-step PROCEDURE.
 */

import {
  detectApprovals,
  detectCorrections,
  detectSkillCandidates,
  draftSkillFromSignal,
  extractCurrentSessionTurns,
  type DraftSkillOptions,
  type SessionBoundaryRef,
  type SessionTurnLine
} from "@muse/agent-core";
import { resolveAuthoredSkillsDir } from "@muse/autoconfigure";
import { adjustSkillReward } from "@muse/mcp";
import { AuthoredSkillStore, type Skill } from "@muse/skills";

import { readLastChatHistory, readSessionBoundaries } from "./chat-history.js";
import { selectRelevantSkills } from "./chat-skills.js";

type ModelProviderLike = DraftSkillOptions["modelProvider"];

export interface AuthorSkillsOptions {
  readonly modelProvider: ModelProviderLike;
  readonly model: string;
  readonly authoredDir?: string;
  readonly maxCandidates?: number;
  readonly readEnv?: () => NodeJS.ProcessEnv;
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
  readonly existingNames?: () => readonly string[];
}

export type AuthorResult =
  | { readonly status: "authored"; readonly skills: readonly string[] }
  | { readonly status: "skipped"; readonly reason: string };

export async function authorSkillsFromSession(options: AuthorSkillsOptions): Promise<AuthorResult> {
  const readLines = options.readLines ?? readLastChatHistory;
  const readBoundaries = options.readBoundaries ?? readSessionBoundaries;
  const env = (options.readEnv ?? (() => process.env))();

  let lines: readonly SessionTurnLine[];
  let boundaries: readonly SessionBoundaryRef[];
  try {
    [lines, boundaries] = await Promise.all([readLines(), readBoundaries()]);
  } catch (cause) {
    return { reason: `history read failed: ${cause instanceof Error ? cause.message : String(cause)}`, status: "skipped" };
  }

  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range) {
    return { reason: "no current-session range", status: "skipped" };
  }

  const signals = detectSkillCandidates(range.turns, { maxCandidates: options.maxCandidates ?? 2 });
  if (signals.length === 0) {
    return { reason: "no procedural corrections this session", status: "skipped" };
  }

  const dir = options.authoredDir ?? resolveAuthoredSkillsDir(env as Record<string, string | undefined>);
  const store = new AuthoredSkillStore({
    dir,
    ...(options.existingNames ? { existingNames: options.existingNames } : {})
  });
  const authored: string[] = [];
  for (const signal of signals) {
    const draft = await draftSkillFromSignal(signal, { model: options.model, modelProvider: options.modelProvider });
    if (!draft) {
      continue;
    }
    try {
      const { action, skill } = await store.writeOrPatch(draft);
      // Only create/patch become active learned skills; "skip" is a no-op and
      // "quarantined" was flagged risky and parked in .quarantine, never active.
      if (action === "create" || action === "patch") {
        authored.push(`${skill.name} (${action})`);
      }
    } catch {
      // fail-soft per skill — one bad write must not lose the rest
    }
  }

  if (authored.length === 0) {
    return { reason: "nothing new authored (all NONE / duplicates)", status: "skipped" };
  }
  return { skills: authored, status: "authored" };
}

export interface SkillRewardChange {
  readonly name: string;
  readonly reward: number;
}

export interface SkillRewardResult {
  readonly decayed: readonly SkillRewardChange[];
  readonly reinforced: readonly SkillRewardChange[];
}

export interface SkillRewardOptions {
  readonly rewardsFile: string;
  readonly authoredDir?: string;
  readonly maxExchanges?: number;
  readonly readEnv?: () => NodeJS.ProcessEnv;
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
  /** Inject the authored skills (test seam); defaults to the AuthoredSkillStore. */
  readonly listSkills?: () => Promise<readonly Skill[]>;
}

/**
 * The RL reward pass for authored skills (P33, the skill counterpart of
 * distillSessionCorrections' reward step): at session end, the authored skill
 * that WOULD have been selected for a corrected request is decayed, and one for
 * an approved request is reinforced — credit-assigned via the SAME
 * `selectRelevantSkills` the live prompt uses, so the reward lands on the skill
 * that actually applied. Once per skill per session; fail-soft.
 */
export async function applySkillRewardsFromSession(options: SkillRewardOptions): Promise<SkillRewardResult> {
  const readLines = options.readLines ?? readLastChatHistory;
  const readBoundaries = options.readBoundaries ?? readSessionBoundaries;
  const env = (options.readEnv ?? (() => process.env))();
  const empty: SkillRewardResult = { decayed: [], reinforced: [] };

  let lines: readonly SessionTurnLine[];
  let boundaries: readonly SessionBoundaryRef[];
  try {
    [lines, boundaries] = await Promise.all([readLines(), readBoundaries()]);
  } catch {
    return empty;
  }
  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range) {
    return empty;
  }
  const maxExchanges = options.maxExchanges ?? 2;
  const corrections = detectCorrections(range.turns, { maxExchanges });
  const approvals = detectApprovals(range.turns, { maxExchanges });
  if (corrections.length === 0 && approvals.length === 0) {
    return empty;
  }

  const skills = options.listSkills
    ? await options.listSkills()
    : await new AuthoredSkillStore({ dir: options.authoredDir ?? resolveAuthoredSkillsDir(env as Record<string, string | undefined>) })
        .listAuthored()
        .catch(() => [] as readonly Skill[]);
  if (skills.length === 0) {
    return empty;
  }

  const adjustedIds = new Set<string>();
  const move = async (request: string | undefined, delta: number): Promise<SkillRewardChange | undefined> => {
    if (!request || request.trim().length === 0) {
      return undefined;
    }
    const top = selectRelevantSkills(skills, request, 1)[0]; // the skill the live prompt would have applied
    if (!top || adjustedIds.has(top.name)) {
      return undefined;
    }
    adjustedIds.add(top.name);
    try {
      const reward = await adjustSkillReward(options.rewardsFile, top.name, delta);
      return reward === undefined ? undefined : { name: top.name, reward };
    } catch {
      return undefined; // fail-soft
    }
  };

  const decayed: SkillRewardChange[] = [];
  for (const exchange of corrections) {
    const moved = await move(exchange.request, -1);
    if (moved) decayed.push(moved);
  }
  const reinforced: SkillRewardChange[] = [];
  for (const approval of approvals) {
    const moved = await move(approval.request, 1);
    if (moved) reinforced.push(moved);
  }
  return { decayed, reinforced };
}
