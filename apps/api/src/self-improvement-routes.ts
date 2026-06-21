import { readPlaybook, readWeaknesses, readSkillRewards, isSkillAvoided, type PlaybookEntry, type WeaknessEntry } from "@muse/mcp";
import { loadSkillsFromDirectory, type Skill } from "@muse/skills";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface WeaknessView {
  readonly axis: string;
  readonly topic: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly hint: string | null;
  readonly pKnown: number | null;
}

export interface WeaknessesResponse {
  readonly total: number;
  readonly entries: readonly WeaknessView[];
}

/**
 * Shape the raw weakness ledger for the web "self-improvement" dashboard:
 * most-frequent first, ties broken by most-recent. Pure (deterministic) so the
 * ordering is unit-tested without a server. `hint`/`pKnown` normalize to null
 * (a JSON-friendly absent value) rather than being omitted.
 */
export function shapeWeaknesses(entries: readonly WeaknessEntry[]): WeaknessesResponse {
  const sorted = [...entries].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
  return {
    total: entries.length,
    entries: sorted.map((e) => ({
      axis: e.axis,
      topic: e.topic,
      count: e.count,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      hint: e.hint ?? null,
      pKnown: e.pKnown ?? null
    }))
  };
}

export interface PlaybookStrategyView {
  readonly id: string;
  readonly text: string;
  readonly tag: string | null;
  readonly origin: string | null;
  readonly reward: number;
  readonly probation: boolean;
  readonly timesObserved: number;
  readonly source: string | null;
  readonly createdAt: string;
}

export interface PlaybookStrategiesResponse {
  readonly total: number;
  readonly entries: readonly PlaybookStrategyView[];
}

/**
 * Shape the raw playbook for the web self-improvement dashboard:
 * highest-reward first, ties broken by most-recent reinforce/create.
 * Pure (deterministic) so the ordering is unit-tested without a server.
 * Absent optional fields normalize to typed zero-values (JSON-friendly).
 */
export function shapePlaybook(entries: readonly PlaybookEntry[]): PlaybookStrategiesResponse {
  const sorted = [...entries].sort((a, b) => {
    const ra = a.reward ?? 0;
    const rb = b.reward ?? 0;
    const recencyA = a.lastReinforcedAt ?? a.createdAt;
    const recencyB = b.lastReinforcedAt ?? b.createdAt;
    return (rb - ra) || recencyB.localeCompare(recencyA);
  });
  return {
    total: entries.length,
    entries: sorted.map((e) => ({
      id: e.id,
      text: e.text,
      tag: e.tag ?? null,
      origin: e.origin ?? null,
      reward: e.reward ?? 0,
      probation: e.probation ?? false,
      timesObserved: e.timesObserved ?? 1,
      source: e.source ?? null,
      createdAt: e.createdAt
    }))
  };
}

export interface SkillView {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly reward: number;
  readonly avoided: boolean;
}

export interface SkillsResponse {
  readonly total: number;
  readonly entries: readonly SkillView[];
}

export function shapeSkills(skills: readonly Skill[], rewards: Record<string, number>): SkillsResponse {
  const mapped: SkillView[] = skills.map((s) => ({
    name: s.name,
    description: s.description,
    source: s.sourceInfo.source,
    reward: rewards[s.name] ?? 0,
    avoided: isSkillAvoided(rewards[s.name])
  }));
  const sorted = [...mapped].sort((a, b) => b.reward - a.reward || a.name.localeCompare(b.name));
  return { total: skills.length, entries: sorted };
}

export interface SelfImprovementRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly weaknessesFile: string;
  readonly playbookFile: string;
  readonly authoredSkillsDir: string;
  readonly skillRewardsFile: string;
}

export function registerSelfImprovementRoutes(server: FastifyInstance, gate: SelfImprovementRoutesGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  // The Whetstone weakness ledger — what Muse has noticed it couldn't answer /
  // didn't do. Read-only; the CLI (`muse doctor --weaknesses`) is the writer.
  server.get("/api/self-improvement/weaknesses", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const entries = await readWeaknesses(gate.weaknessesFile);
    return shapeWeaknesses(entries);
  });

  // The learned-strategy playbook. Read-only; the CLI + agent runtime are the writers.
  server.get("/api/self-improvement/playbook", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const entries = await readPlaybook(gate.playbookFile);
    return shapePlaybook(entries);
  });

  // The authored skill library merged with reward signals. Read-only;
  // the background-review engine + skill runtime are the writers.
  server.get("/api/self-improvement/skills", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const [skills, rewards] = await Promise.all([
      loadSkillsFromDirectory(gate.authoredSkillsDir, "authored"),
      readSkillRewards(gate.skillRewardsFile)
    ]);
    return shapeSkills(skills, rewards);
  });
}
