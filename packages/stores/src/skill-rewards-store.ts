/**
 * Sidecar reward store for authored skills (`~/.muse/skill-rewards.json`) — the
 * RL reward loop (P33) extended from the strategy playbook to skills. Kept in a
 * SEPARATE file keyed by skill name, NOT in each SKILL.md's frontmatter, so the
 * reward signal never has to round-trip through the authored-skill serializer
 * (a corrected skill's reward decays without rewriting its body). Same
 * durability posture as the sibling stores: atomic fsync+rename write, tolerant
 * read, per-file mutation queue so concurrent adjusts don't clobber.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

/** Reward bounds — must match agent-core's PLAYBOOK_REWARD_MIN/MAX (mcp stays free of an agent-core dependency). */
export const SKILL_REWARD_MIN = -5;
export const SKILL_REWARD_MAX = 5;
/**
 * A skill corrected to or below this reward is AVOIDED — excluded from the
 * per-turn skill selection so a repeatedly-corrected skill stops being applied
 * (the soft, reversible counterpart to deletion; an approval can lift it back).
 * Matches the playbook's PLAYBOOK_AVOID_BELOW.
 */
export const SKILL_AVOID_BELOW = -4;

/** Read the name→reward map. Tolerant: a missing/corrupt file or bad row degrades to {}. */
export async function readSkillRewards(file: string): Promise<Record<string, number>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  const rewards = (parsed as { rewards?: unknown })?.rewards;
  if (!rewards || typeof rewards !== "object" || Array.isArray(rewards)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(rewards as Record<string, unknown>)) {
    if (name.length > 0 && typeof value === "number" && Number.isFinite(value)) {
      out[name] = Math.max(SKILL_REWARD_MIN, Math.min(SKILL_REWARD_MAX, value));
    }
  }
  return out;
}

/** True when a skill's reward has sunk to/below the avoid line. */
export function isSkillAvoided(reward: number | undefined): boolean {
  return typeof reward === "number" && Number.isFinite(reward) && reward <= SKILL_AVOID_BELOW;
}

/**
 * Reinforce (delta > 0) or decay (delta < 0) a skill's reward, clamped to
 * [SKILL_REWARD_MIN, SKILL_REWARD_MAX]. Serialised read-modify-write (no lost
 * update). Returns the new reward, or undefined when delta is not finite.
 */
export async function adjustSkillReward(file: string, name: string, delta: number): Promise<number | undefined> {
  if (name.length === 0 || !Number.isFinite(delta)) {
    return undefined;
  }
  return withFileMutationQueue(file, async () => {
    const rewards = await readSkillRewards(file);
    const next = Math.max(SKILL_REWARD_MIN, Math.min(SKILL_REWARD_MAX, (rewards[name] ?? 0) + delta));
    rewards[name] = next;
    await atomicWriteFile(file, `${JSON.stringify({ rewards }, null, 2)}\n`);
    return next;
  });
}
