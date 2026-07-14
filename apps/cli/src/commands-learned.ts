/**
 * `muse learned` — one honest view of what Muse has LEARNED about working with
 * you: the strategies and skills it now trusts (high reward), the ones it has
 * learned to avoid (corrected too often), and the grounded reflections it has
 * formed. The "shows its work" edge turned on Muse's OWN self-improvement,
 * which learns by default — this view makes it legible enough to trust (or
 * turn off). Pure composition of the playbook, authored-skill, skill-reward,
 * and reflection stores — no model call.
 */

import { PLAYBOOK_AVOID_BELOW } from "@muse/agent-core";
import { resolveLearningPauseFile, resolvePatternsFiredFile, resolvePlaybookFile, resolveVetoesFile } from "@muse/autoconfigure";
import { aggregateActivitySignals, detectTimeOfDayPatterns, detectWeeklyTaskPatterns, FileUserMemoryStore, type PatternMatch } from "@muse/memory";
import { isGoalKey, isVetoKey } from "@muse/recall";
import { isLearningPaused, isPatternDismissed, queryPlaybook, queryVetoes, readPatternsFired, readReflections, readSkillRewards, SKILL_AVOID_BELOW, type ActionVeto } from "@muse/stores";
import { stripUntrustedTerminalChars } from "@muse/shared";
import { AuthoredSkillStore } from "@muse/skills";
import type { Command } from "commander";

import { resolveReflectionsFile } from "./commands-reflections.js";
import { resolveAuthoredSkillsDir, resolveSkillRewardsFile } from "./commands-skills.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

const TRUST_AT = 1; // reward ≥ this = a strategy/skill Muse has learned to trust
const MAX_REFLECTIONS = 5;
// Show a trusted strategy as "fading" once it has gone this long without a
// positive reinforce — a few days BEFORE the daemon's 30-day disuse-decay
// (PLAYBOOK_DECAY_STALE_DAYS) actually lowers its reward, so the user SEES the
// trajectory ("you've stopped reinforcing this") before the value drops.
const FADING_AFTER_DAYS = 21;
const DAY_MS = 86_400_000;

export interface LearnedDigestInput {
  readonly strategies: readonly {
    /** Playbook entry id (from `queryPlaybook`) — enables an exact per-line undo command. Absent ⇒ the line falls back to no escape hatch (e.g. an older test fixture). */
    readonly id?: string;
    readonly text: string;
    readonly tag?: string;
    readonly reward?: number;
    readonly probation?: boolean;
    readonly createdAt?: string;
    readonly lastReinforcedAt?: string;
    readonly origin?: string;
    readonly source?: string;
    readonly timesObserved?: number;
  }[];
  readonly skills: readonly { readonly name: string; readonly reward: number }[];
  readonly reflections: readonly { readonly insight: string; readonly createdAtMs: number }[];
  /** Injectable clock for the "fading / last reinforced" trajectory. */
  readonly nowMs?: number;
  /** When true, a banner notes background learning is paused (B1 §5 kill switch). */
  readonly paused?: boolean;
  /**
   * Facts & preferences remembered about the user — already stripped of
   * `veto:`/`goal:`-prefixed preference keys (those are a soft "never
   * suggest" / "steer toward" mechanism with their own home in
   * `muse memory show`, not the same thing as an action-class veto below).
   */
  readonly memory?: {
    readonly facts: Readonly<Record<string, string>>;
    readonly preferences: Readonly<Record<string, string>>;
  };
  /** Action-class vetoes ("don't do that again") — the `~/.muse/vetoes.json` backend `muse vetoes` now exposes. */
  readonly vetoes?: readonly Pick<ActionVeto, "id" | "objectiveId" | "scope" | "reason">[];
  /** Detected routine patterns (time-of-day / weekly), highest confidence first. */
  readonly patterns?: readonly { readonly id: string; readonly suggestion: string; readonly confidence: number }[];
}

const rewardOf = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Every store value rendered here can trace back to model/tool output — a
 * distilled strategy, a reflection insight, an auto-extracted fact. This is the
 * terminal-display chokepoint for all of it. Facts and preferences ARE stripped
 * of control bytes at write time, but that strip keeps the newline, and a newline
 * is enough to forge a fake section header in the very view this command exists to
 * audit — so every value passes through here regardless of its write-time
 * treatment. Strips ANSI/control bytes and collapses embedded whitespace.
 */
function sanitizeForDisplay(value: string): string {
  return stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
}

/** Longest "why" source shown inline before it's truncated with an ellipsis. */
const MAX_SOURCE_CHARS = 80;

/**
 * The provenance "why" line for a learned strategy (B1 §4) — so the user can
 * judge whether to keep it. Grounded strategies show the verbatim correction
 * that taught them; reflected ones are flagged synthetic; manual/legacy ones
 * get no extra line (their origin is self-evident). Empty string ⇒ no line.
 */
function whyLine(strategy: { readonly origin?: string; readonly source?: string }): string {
  if (strategy.origin === "reflected") {
    return "    ↳ from a reflection (synthetic — ranked below grounded)";
  }
  if (strategy.origin === "grounded" && strategy.source && strategy.source.trim().length > 0) {
    const src = sanitizeForDisplay(strategy.source);
    const shown = src.length > MAX_SOURCE_CHARS ? `${src.slice(0, MAX_SOURCE_CHARS - 1)}…` : src;
    return `    ↳ learned from your correction: "${shown}"`;
  }
  return "";
}

/**
 * The disuse trajectory suffix for a trusted strategy (B1 §2): how long since
 * it was last positively reinforced, and a "↓ fading" flag once that gap passes
 * `FADING_AFTER_DAYS` — so the user SEES a strategy losing trust BEFORE the idle
 * daemon decays its reward. Empty when there's no recency anchor or it's fresh.
 */
function trajectorySuffix(
  strategy: { readonly createdAt?: string; readonly lastReinforcedAt?: string },
  nowMs: number
): string {
  const anchorMs = Date.parse(strategy.lastReinforcedAt ?? strategy.createdAt ?? "");
  if (!Number.isFinite(anchorMs)) {
    return "";
  }
  const days = Math.floor((nowMs - anchorMs) / DAY_MS);
  if (days < FADING_AFTER_DAYS) {
    return "";
  }
  const reinforced = strategy.lastReinforcedAt ? "reinforced" : "added";
  return `  ↓ fading (last ${reinforced} ${days.toString()}d ago)`;
}

/** Trailing per-line escape hatch — "" when there's no id to target (keeps older callers/tests unaffected). */
function undoHint(label: string, cmd: string | undefined): string {
  return cmd ? `  ${label} → \`${cmd}\`` : "";
}

/** Render the digest. Pure (data in, text out) so it is directly testable. */
export function renderLearnedDigest(input: LearnedDigestInput): string {
  // Probation strategies (learned UNATTENDED on idle) are shown in their own
  // section — recorded + visible but not yet applied — and excluded from the
  // trusted/avoided lists so they're never double-listed.
  const probationStrategies = input.strategies.filter((s) => s.probation === true);
  const trustedStrategies = input.strategies
    .filter((s) => s.probation !== true && rewardOf(s.reward) >= TRUST_AT)
    .sort((a, b) => rewardOf(b.reward) - rewardOf(a.reward));
  const trustedSkills = input.skills.filter((s) => s.reward >= TRUST_AT).sort((a, b) => b.reward - a.reward);
  const avoidedStrategies = input.strategies.filter((s) => s.probation !== true && rewardOf(s.reward) <= PLAYBOOK_AVOID_BELOW);
  const avoidedSkills = input.skills.filter((s) => s.reward <= SKILL_AVOID_BELOW);
  // Every non-probation strategy must land in EXACTLY one bucket: trusted
  // (reward ≥ TRUST_AT), avoided (reward ≤ PLAYBOOK_AVOID_BELOW), or here —
  // the residual "everything else" bucket. Gating this on `origin ===
  // "manual"` (the previous version) left any strategy with a different/
  // absent origin invisible — a pre-`origin`-field legacy entry, or a reward
  // that decayed/was corrected back down into the neutral band — even though
  // it was still being injected into every prompt.
  const notYetReinforced = input.strategies.filter(
    (s) => s.probation !== true && rewardOf(s.reward) > PLAYBOOK_AVOID_BELOW && rewardOf(s.reward) < TRUST_AT
  );
  const recent = [...input.reflections].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, MAX_REFLECTIONS);
  const facts = input.memory ? Object.entries(input.memory.facts) : [];
  const preferences = input.memory ? Object.entries(input.memory.preferences) : [];
  const vetoes = input.vetoes ?? [];
  const patterns = input.patterns ?? [];

  const nothing =
    trustedStrategies.length === 0 &&
    trustedSkills.length === 0 &&
    avoidedStrategies.length === 0 &&
    avoidedSkills.length === 0 &&
    probationStrategies.length === 0 &&
    notYetReinforced.length === 0 &&
    recent.length === 0 &&
    facts.length === 0 &&
    preferences.length === 0 &&
    vetoes.length === 0 &&
    patterns.length === 0;
  const pausedBanner = input.paused ? ["⏸ Background learning is PAUSED (`muse playbook resume` to continue).", ""] : [];
  if (nothing) {
    return [
      ...pausedBanner,
      "Muse hasn't learned anything about working with you yet.",
      "",
      "Learning is ON by default — correct or approve Muse in chat and it reinforces",
      "what works and retires what it keeps getting wrong. To turn it off for a session:",
      "  MUSE_PLAYBOOK_DISTILL_ENABLED=false  MUSE_SKILL_AUTHOR_ENABLED=false"
    ].join("\n");
  }

  const lines: string[] = [...pausedBanner, "What Muse has learned about working with you", ""];
  const reward = (n: number): string => `${n > 0 ? "+" : ""}${n.toString()}`;

  const nowMs = input.nowMs ?? Date.now();
  if (facts.length > 0 || preferences.length > 0) {
    lines.push("Facts & preferences Muse remembers about you:");
    // Facts and preferences are model-derived (auto-extraction), so a value can
    // carry a newline that forges a section header ("...\nVetoed actions:\n  • ...")
    // in the very screen the user consults to audit what Muse learned. Write-time
    // sanitisation strips control bytes but KEEPS the newline, so this display
    // chokepoint must collapse it — same treatment every other rendered store value
    // already gets. The key is rendered too and is equally attacker-influenced.
    for (const [key, value] of facts) {
      lines.push(`  • ${sanitizeForDisplay(key.replace(/_/gu, " "))}: ${sanitizeForDisplay(value)}${undoHint("wrong?", `muse memory forget ${key}`)}`);
    }
    for (const [key, value] of preferences) {
      lines.push(`  • ${sanitizeForDisplay(key.replace(/_/gu, " "))}: ${sanitizeForDisplay(value)}${undoHint("wrong?", `muse memory forget ${key}`)}`);
    }
    lines.push("");
  }
  if (trustedStrategies.length > 0) {
    lines.push("Trusted strategies (reinforced by your feedback):");
    for (const s of trustedStrategies) {
      lines.push(`  • ${sanitizeForDisplay(s.text)}${s.tag ? ` (${sanitizeForDisplay(s.tag)})` : ""}  ⟨${reward(rewardOf(s.reward))}⟩${trajectorySuffix(s, nowMs)}${undoHint("wrong?", s.id && `muse playbook undo ${s.id}`)}`);
      const why = whyLine(s);
      if (why) lines.push(why);
    }
    lines.push("");
  }
  if (trustedSkills.length > 0) {
    lines.push("Trusted skills:");
    for (const s of trustedSkills) lines.push(`  • ${sanitizeForDisplay(s.name)}  ⟨${reward(s.reward)}⟩${undoHint("wrong?", `muse skills reward ${s.name} --down`)}`);
    lines.push("");
  }
  if (notYetReinforced.length > 0) {
    lines.push("Not yet reinforced — recorded, and being applied:");
    for (const s of notYetReinforced) {
      const addedManually = s.origin === "manual" ? " (added manually)" : "";
      lines.push(`  • ${sanitizeForDisplay(s.text)}${s.tag ? ` (${sanitizeForDisplay(s.tag)})` : ""}${addedManually}${undoHint("wrong?", s.id && `muse playbook undo ${s.id}`)}`);
    }
    lines.push("");
  }
  if (probationStrategies.length > 0) {
    lines.push("Learning while idle (on probation — recorded, NOT yet applied until you reinforce it):");
    for (const s of probationStrategies) {
      // "raised N×" — the user gave a near-duplicate correction N times; the
      // distiller consolidated rather than duplicating. Shown so a repeatedly-
      // raised point reads as worth reinforcing, WITHOUT auto-graduating it.
      const raised = typeof s.timesObserved === "number" && s.timesObserved >= 2 ? `  · raised ${s.timesObserved.toString()}×` : "";
      lines.push(`  • ${sanitizeForDisplay(s.text)}${s.tag ? ` (${sanitizeForDisplay(s.tag)})` : ""}  ⟨probation⟩${raised}${undoHint("wrong?", s.id && `muse playbook undo ${s.id}`)}`);
      const why = whyLine(s);
      if (why) lines.push(why);
    }
    lines.push("");
  }
  if (avoidedStrategies.length > 0 || avoidedSkills.length > 0) {
    lines.push("Learned to avoid (corrected too often — no longer applied):");
    for (const s of avoidedStrategies) lines.push(`  • strategy: ${sanitizeForDisplay(s.text)}  ⟨${reward(rewardOf(s.reward))}⟩${undoHint("not actually wrong?", s.id && `muse playbook reward ${s.id}`)}`);
    for (const s of avoidedSkills) lines.push(`  • skill: ${sanitizeForDisplay(s.name)}  ⟨${reward(s.reward)}⟩${undoHint("not actually wrong?", `muse skills reward ${s.name}`)}`);
    lines.push("");
  }
  if (vetoes.length > 0) {
    lines.push("Vetoed actions (you told Muse never to do these again):");
    for (const v of vetoes) {
      const why = v.reason ? ` — ${sanitizeForDisplay(v.reason)}` : "";
      lines.push(`  • ${sanitizeForDisplay(v.objectiveId)} · ${sanitizeForDisplay(v.scope)}${why}${undoHint("wrong?", `muse vetoes remove ${v.id}`)}`);
    }
    lines.push("");
  }
  if (patterns.length > 0) {
    lines.push("Detected routine patterns:");
    for (const p of patterns) {
      lines.push(`  • ${sanitizeForDisplay(p.suggestion)}  (confidence ${(p.confidence * 100).toFixed(0)}%)${undoHint("not helpful?", `muse pattern dismiss ${p.id}`)}`);
    }
    lines.push("");
  }
  if (recent.length > 0) {
    lines.push("Recent reflections (grounded in your real sessions):");
    for (const r of recent) lines.push(`  • ${sanitizeForDisplay(r.insight)}  [${new Date(r.createdAtMs).toISOString().slice(0, 10)}]`);
    lines.push("");
  }
  lines.push(
    "Tune trust with `muse playbook reward` / `muse skills reward`; full lists: " +
    "`muse playbook`, `muse skills authored`, `muse reflections`, `muse memory show`, `muse pattern list`, `muse vetoes list`."
  );
  return lines.join("\n");
}

/**
 * The one-line "you FEEL it next session" beat: how many strategies Muse
 * distilled UNATTENDED (on probation) since you were last here. Deterministic
 * (no model call) — counts real probation entries, never fabricates. Undefined
 * when there's nothing new to surface, so a session opener stays silent.
 */
export function formatIdleLearnedNotice(probationCount: number): string | undefined {
  if (probationCount <= 0) {
    return undefined;
  }
  const n = probationCount.toString();
  const thing = probationCount === 1 ? "thing" : "things";
  return `💡 I learned ${n} ${thing} while you were away (on probation) — review with \`muse learned\`.`;
}

/**
 * The idle-learned session-start notice for `userId`, or undefined when none.
 * Reads the playbook (fail-soft) and counts probation strategies. Pure of the
 * REPL so it's directly testable.
 */
export async function idleLearnedNoticeForUser(
  userId: string,
  env: Record<string, string | undefined> = process.env
): Promise<string | undefined> {
  const strategies = await queryPlaybook(resolvePlaybookFile(env), userId).catch(() => []);
  return formatIdleLearnedNotice(strategies.filter((s) => s.probation === true).length);
}

/** Cap on how many detected patterns show in the single index (full list: `muse pattern list`). */
const MAX_DIGEST_PATTERNS = 3;

/**
 * Local, deterministic (no model call) pattern detection — same detectors
 * `muse pattern list` runs, minus anything the user already dismissed via
 * `muse pattern dismiss` (a dismissal is learned avoidance; showing it back
 * here would make that command's "won't suggest it again" promise false).
 */
async function detectPatternsForDigest(env: Record<string, string | undefined>): Promise<readonly PatternMatch[]> {
  const [signals, fired] = await Promise.all([
    aggregateActivitySignals(),
    readPatternsFired(resolvePatternsFiredFile(env)).catch(() => [])
  ]);
  const now = new Date();
  return [...detectTimeOfDayPatterns(now, signals), ...detectWeeklyTaskPatterns(now, signals)]
    .filter((m) => !isPatternDismissed(fired, m.id))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_DIGEST_PATTERNS);
}

export function registerLearnedCommand(program: Command, io: ProgramIO): void {
  program
    .command("learned")
    .description("The single index of everything Muse has learned about you — facts/preferences, trusted/avoided strategies & skills, probation, vetoed actions, detected patterns, and recent reflections")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .action(async (options: { readonly user?: string }) => {
      const userId = resolveDefaultUserKey({ override: options.user });
      const env = process.env;
      const [strategies, authored, skillRewards, reflections, paused, memoryRecord, vetoes, patterns] = await Promise.all([
        queryPlaybook(resolvePlaybookFile(env), userId).catch(() => []),
        new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir() }).listAuthored().catch(() => []),
        readSkillRewards(resolveSkillRewardsFile()).catch(() => ({} as Record<string, number>)),
        readReflections(resolveReflectionsFile()).catch(() => []),
        isLearningPaused(resolveLearningPauseFile(env)).catch(() => false),
        new FileUserMemoryStore().findByUserId(userId).catch(() => undefined),
        queryVetoes(resolveVetoesFile(env), { userId }).catch(() => []),
        detectPatternsForDigest(env).catch(() => [])
      ]);
      const skills = authored.map((s) => ({ name: s.name, reward: rewardOf(skillRewards[s.name]) }));
      // `veto:`/`goal:`-prefixed preferences are a DIFFERENT mechanism (soft
      // "never suggest" / "steer toward", already surfaced by `muse memory
      // show`) — excluded here so they aren't confused with an action-class
      // veto below.
      const preferences = Object.fromEntries(
        Object.entries(memoryRecord?.preferences ?? {}).filter(([key]) => !isVetoKey(key) && !isGoalKey(key))
      );
      io.stdout(`${renderLearnedDigest({
        memory: { facts: memoryRecord?.facts ?? {}, preferences },
        paused,
        patterns: patterns.map((p) => ({ confidence: p.confidence, id: p.id, suggestion: p.suggestion })),
        reflections,
        skills,
        strategies,
        vetoes
      })}\n`);
    });
}
