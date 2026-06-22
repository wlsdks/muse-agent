/**
 * `muse learned` — one honest view of what Muse has LEARNED about working with
 * you: the strategies and skills it now trusts (high reward), the ones it has
 * learned to avoid (corrected too often), and the grounded reflections it has
 * formed. The "shows its work" edge turned on Muse's OWN self-improvement, so
 * the (default-off) learning is legible enough to trust and turn on. Pure
 * composition of the playbook, authored-skill, skill-reward, and reflection
 * stores — no model call.
 */

import { PLAYBOOK_AVOID_BELOW } from "@muse/agent-core";
import { resolveLearningPauseFile, resolvePlaybookFile } from "@muse/autoconfigure";
import { isLearningPaused, queryPlaybook, readReflections, readSkillRewards, SKILL_AVOID_BELOW } from "@muse/stores";
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
}

const rewardOf = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

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
    const src = strategy.source.replace(/\s+/gu, " ").trim();
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
  const recent = [...input.reflections].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, MAX_REFLECTIONS);

  const nothing =
    trustedStrategies.length === 0 &&
    trustedSkills.length === 0 &&
    avoidedStrategies.length === 0 &&
    avoidedSkills.length === 0 &&
    probationStrategies.length === 0 &&
    recent.length === 0;
  const pausedBanner = input.paused ? ["⏸ Background learning is PAUSED (`muse playbook resume` to continue).", ""] : [];
  if (nothing) {
    return [
      ...pausedBanner,
      "Muse hasn't learned anything about working with you yet.",
      "",
      "Learning is OFF by default. Turn it on for a session with:",
      "  MUSE_PLAYBOOK_DISTILL_ENABLED=true  MUSE_SKILL_AUTHOR_ENABLED=true",
      "then correct or approve Muse in chat — it reinforces what works and retires what it keeps getting wrong."
    ].join("\n");
  }

  const lines: string[] = [...pausedBanner, "What Muse has learned about working with you", ""];
  const reward = (n: number): string => `${n > 0 ? "+" : ""}${n.toString()}`;

  const nowMs = input.nowMs ?? Date.now();
  if (trustedStrategies.length > 0) {
    lines.push("Trusted strategies (reinforced by your feedback):");
    for (const s of trustedStrategies) {
      lines.push(`  • ${s.text}${s.tag ? ` (${s.tag})` : ""}  ⟨${reward(rewardOf(s.reward))}⟩${trajectorySuffix(s, nowMs)}`);
      const why = whyLine(s);
      if (why) lines.push(why);
    }
    lines.push("");
  }
  if (trustedSkills.length > 0) {
    lines.push("Trusted skills:");
    for (const s of trustedSkills) lines.push(`  • ${s.name}  ⟨${reward(s.reward)}⟩`);
    lines.push("");
  }
  if (probationStrategies.length > 0) {
    lines.push("Learning while idle (on probation — recorded, NOT yet applied until you reinforce it):");
    for (const s of probationStrategies) {
      // "raised N×" — the user gave a near-duplicate correction N times; the
      // distiller consolidated rather than duplicating. Shown so a repeatedly-
      // raised point reads as worth reinforcing, WITHOUT auto-graduating it.
      const raised = typeof s.timesObserved === "number" && s.timesObserved >= 2 ? `  · raised ${s.timesObserved.toString()}×` : "";
      lines.push(`  • ${s.text}${s.tag ? ` (${s.tag})` : ""}  ⟨probation⟩${raised}`);
      const why = whyLine(s);
      if (why) lines.push(why);
    }
    lines.push("");
  }
  if (avoidedStrategies.length > 0 || avoidedSkills.length > 0) {
    lines.push("Learned to avoid (corrected too often — no longer applied):");
    for (const s of avoidedStrategies) lines.push(`  • strategy: ${s.text}  ⟨${reward(rewardOf(s.reward))}⟩`);
    for (const s of avoidedSkills) lines.push(`  • skill: ${s.name}  ⟨${reward(s.reward)}⟩`);
    lines.push("");
  }
  if (recent.length > 0) {
    lines.push("Recent reflections (grounded in your real sessions):");
    for (const r of recent) lines.push(`  • ${r.insight}  [${new Date(r.createdAtMs).toISOString().slice(0, 10)}]`);
    lines.push("");
  }
  lines.push("Tune trust with `muse playbook reward` / `muse skills reward`; full lists: `muse playbook`, `muse skills authored`, `muse reflections`.");
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

export function registerLearnedCommand(program: Command, io: ProgramIO): void {
  program
    .command("learned")
    .description("Show what Muse has learned about working with you — trusted/avoided strategies & skills + recent reflections")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .action(async (options: { readonly user?: string }) => {
      const userId = resolveDefaultUserKey({ override: options.user });
      const env = process.env as Record<string, string | undefined>;
      const [strategies, authored, skillRewards, reflections, paused] = await Promise.all([
        queryPlaybook(resolvePlaybookFile(env), userId).catch(() => []),
        new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir() }).listAuthored().catch(() => []),
        readSkillRewards(resolveSkillRewardsFile()).catch(() => ({} as Record<string, number>)),
        readReflections(resolveReflectionsFile()).catch(() => []),
        isLearningPaused(resolveLearningPauseFile(env)).catch(() => false)
      ]);
      const skills = authored.map((s) => ({ name: s.name, reward: rewardOf(skillRewards[s.name]) }));
      io.stdout(`${renderLearnedDigest({ paused, reflections, skills, strategies })}\n`);
    });
}
