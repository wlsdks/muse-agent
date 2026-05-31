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
import { resolvePlaybookFile } from "@muse/autoconfigure";
import { queryPlaybook, readReflections, readSkillRewards, SKILL_AVOID_BELOW } from "@muse/mcp";
import { AuthoredSkillStore } from "@muse/skills";
import type { Command } from "commander";

import { resolveReflectionsFile } from "./commands-reflections.js";
import { resolveAuthoredSkillsDir, resolveSkillRewardsFile } from "./commands-skills.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

const TRUST_AT = 1; // reward ≥ this = a strategy/skill Muse has learned to trust
const MAX_REFLECTIONS = 5;

export interface LearnedDigestInput {
  readonly strategies: readonly { readonly text: string; readonly tag?: string; readonly reward?: number }[];
  readonly skills: readonly { readonly name: string; readonly reward: number }[];
  readonly reflections: readonly { readonly insight: string; readonly createdAtMs: number }[];
}

const rewardOf = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Render the digest. Pure (data in, text out) so it is directly testable. */
export function renderLearnedDigest(input: LearnedDigestInput): string {
  const trustedStrategies = input.strategies
    .filter((s) => rewardOf(s.reward) >= TRUST_AT)
    .sort((a, b) => rewardOf(b.reward) - rewardOf(a.reward));
  const trustedSkills = input.skills.filter((s) => s.reward >= TRUST_AT).sort((a, b) => b.reward - a.reward);
  const avoidedStrategies = input.strategies.filter((s) => rewardOf(s.reward) <= PLAYBOOK_AVOID_BELOW);
  const avoidedSkills = input.skills.filter((s) => s.reward <= SKILL_AVOID_BELOW);
  const recent = [...input.reflections].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, MAX_REFLECTIONS);

  const nothing =
    trustedStrategies.length === 0 &&
    trustedSkills.length === 0 &&
    avoidedStrategies.length === 0 &&
    avoidedSkills.length === 0 &&
    recent.length === 0;
  if (nothing) {
    return [
      "Muse hasn't learned anything about working with you yet.",
      "",
      "Learning is OFF by default. Turn it on for a session with:",
      "  MUSE_PLAYBOOK_DISTILL_ENABLED=true  MUSE_SKILL_AUTHOR_ENABLED=true",
      "then correct or approve Muse in chat — it reinforces what works and retires what it keeps getting wrong."
    ].join("\n");
  }

  const lines: string[] = ["What Muse has learned about working with you", ""];
  const reward = (n: number): string => `${n > 0 ? "+" : ""}${n.toString()}`;

  if (trustedStrategies.length > 0) {
    lines.push("Trusted strategies (reinforced by your feedback):");
    for (const s of trustedStrategies) lines.push(`  • ${s.text}${s.tag ? ` (${s.tag})` : ""}  ⟨${reward(rewardOf(s.reward))}⟩`);
    lines.push("");
  }
  if (trustedSkills.length > 0) {
    lines.push("Trusted skills:");
    for (const s of trustedSkills) lines.push(`  • ${s.name}  ⟨${reward(s.reward)}⟩`);
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

export function registerLearnedCommand(program: Command, io: ProgramIO): void {
  program
    .command("learned")
    .description("Show what Muse has learned about working with you — trusted/avoided strategies & skills + recent reflections")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .action(async (options: { readonly user?: string }) => {
      const userId = resolveDefaultUserKey({ override: options.user });
      const env = process.env as Record<string, string | undefined>;
      const [strategies, authored, skillRewards, reflections] = await Promise.all([
        queryPlaybook(resolvePlaybookFile(env), userId).catch(() => []),
        new AuthoredSkillStore({ dir: resolveAuthoredSkillsDir() }).listAuthored().catch(() => []),
        readSkillRewards(resolveSkillRewardsFile()).catch(() => ({} as Record<string, number>)),
        readReflections(resolveReflectionsFile()).catch(() => [])
      ]);
      const skills = authored.map((s) => ({ name: s.name, reward: rewardOf(skillRewards[s.name]) }));
      io.stdout(`${renderLearnedDigest({ reflections, skills, strategies })}\n`);
    });
}
