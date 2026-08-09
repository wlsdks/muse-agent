import { isLearningPaused, readPendingLearnEvents, readPlaybook, readSkillUsage, readWeaknesses, readSkillRewards, adjustSkillReward, isSkillAvoided, readReflections, listReflections, type PlaybookEntry, type SkillUsageMap, type WeaknessEntry, type StoredReflection } from "@muse/stores";
import { loadSkillsFromDirectory, type Skill } from "@muse/skills";
import type { FastifyInstance } from "fastify";
import { dirname, join } from "node:path";

import { CONSOLIDATE_IDLE_FLAG, resolveConsolidateIdleEnabled } from "./consolidate-idle-flag.js";
import type { ConsolidateTickDecision, ConsolidateTickStatus } from "./consolidate-tick.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface WeaknessView {
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

interface PlaybookStrategyView {
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

interface SkillView {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly reward: number;
  readonly avoided: boolean;
  readonly useCount: number;
  readonly viewCount: number;
  readonly lastActivity: string | null;
}

export interface SkillsResponse {
  readonly total: number;
  readonly entries: readonly SkillView[];
}

export function shapeSkills(skills: readonly Skill[], rewards: Record<string, number>, usage: SkillUsageMap = {}): SkillsResponse {
  const mapped: SkillView[] = skills.map((s) => ({
    lastActivity: usage[s.name]?.lastActivity ?? null,
    name: s.name,
    description: s.description,
    source: s.sourceInfo.source,
    reward: rewards[s.name] ?? 0,
    avoided: isSkillAvoided(rewards[s.name]),
    useCount: usage[s.name]?.useCount ?? 0,
    viewCount: usage[s.name]?.viewCount ?? 0
  }));
  const sorted = [...mapped].sort((a, b) => b.reward - a.reward || a.name.localeCompare(b.name));
  return { total: skills.length, entries: sorted };
}

/**
 * Validates the `delta` field from an incoming reward-adjustment body.
 * Returns the delta if it is a finite, non-zero number; otherwise undefined.
 * Covers missing, null, string, NaN, Infinity, and zero inputs.
 */
export function parseRewardDelta(body: unknown): number | undefined {
  if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const delta = (body as Record<string, unknown>)["delta"];
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) {
    return undefined;
  }
  return delta;
}

interface ReflectionView {
  readonly id: string;
  readonly insight: string;
  readonly supportCount: number;
  readonly sourceCount: number;
  readonly createdAt: number;
}

export interface ReflectionsResponse {
  readonly total: number;
  readonly entries: readonly ReflectionView[];
}

export type SelfImprovementRuntimeState = "dormant" | "running" | "unconfigured";

export interface SelfImprovementStatusResponse {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly pendingCorrections: number;
  readonly state: SelfImprovementRuntimeState;
  readonly lastObservedAtIso: string | null;
  readonly lastDecision: ConsolidateTickDecision | null;
}

export interface SelfImprovementStatusInput {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly pendingCorrections: number;
  readonly daemonStatus?: ConsolidateTickStatus;
}

export function shapeSelfImprovementStatus(input: SelfImprovementStatusInput): SelfImprovementStatusResponse {
  const daemonAvailable = input.daemonStatus !== undefined;
  return {
    configured: input.configured,
    enabled: input.enabled,
    paused: input.paused,
    pendingCorrections: input.pendingCorrections,
    state: !input.configured ? "unconfigured" : daemonAvailable && input.enabled ? "running" : "dormant",
    lastObservedAtIso: input.daemonStatus?.lastObservedAtIso ?? null,
    lastDecision: input.daemonStatus?.lastDecision ?? null
  };
}

export function shapeReflections(reflections: readonly StoredReflection[]): ReflectionsResponse {
  const ordered = listReflections(reflections);
  return {
    total: reflections.length,
    entries: ordered.map((r) => ({
      id: r.id,
      insight: r.insight,
      supportCount: r.supportCount,
      sourceCount: r.sourceIds.length,
      createdAt: r.createdAtMs
    }))
  };
}

export interface SelfImprovementRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtimeSettings?: ServerOptions["runtimeSettings"];
  readonly configured: boolean;
  readonly learnQueueFile: string;
  readonly learningPauseFile: string;
  readonly consolidateStatus?: () => ConsolidateTickStatus | undefined;
  readonly weaknessesFile: string;
  readonly playbookFile: string;
  readonly authoredSkillsDir: string;
  readonly skillRewardsFile: string;
  readonly skillUsageFile?: string;
  readonly reflectionsFile: string;
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
    const [skills, rewards, usage] = await Promise.all([
      loadSkillsFromDirectory(gate.authoredSkillsDir, "authored"),
      readSkillRewards(gate.skillRewardsFile),
      readSkillUsage(gate.skillUsageFile ?? join(dirname(gate.skillRewardsFile), "skill-usage.json"))
    ]);
    return shapeSkills(skills, rewards, usage);
  });

  server.get("/api/self-improvement/reflections", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const reflections = await readReflections(gate.reflectionsFile);
    return shapeReflections(reflections);
  });

  server.get("/api/self-improvement/status", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }

    let runtimeSetting;
    let runtimeSettingReadFailed = false;
    try {
      runtimeSetting = await gate.runtimeSettings?.find(CONSOLIDATE_IDLE_FLAG);
    } catch {
      runtimeSettingReadFailed = true;
    }
    const [pending, paused] = await Promise.all([
      readPendingLearnEvents(gate.learnQueueFile),
      isLearningPaused(gate.learningPauseFile)
    ]);
    return shapeSelfImprovementStatus({
      configured: gate.configured,
      daemonStatus: gate.consolidateStatus?.(),
      enabled: runtimeSettingReadFailed ? false : resolveConsolidateIdleEnabled(gate.env, runtimeSetting),
      paused,
      pendingCorrections: pending.length
    });
  });

  // Adjust a skill's learned reward (thumbs up/down). Local self-tuning —
  // not outbound to a third party, so auth gate only (no draft-first).
  server.post("/api/self-improvement/skills/:name/reward", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const { name } = request.params as { name: string };
    const delta = parseRewardDelta(request.body);
    if (delta === undefined) {
      return reply.status(400).send({ error: "invalid delta" });
    }
    const reward = await adjustSkillReward(gate.skillRewardsFile, decodeURIComponent(name), delta);
    if (reward === undefined) {
      return reply.status(400).send({ error: "invalid skill name" });
    }
    return { name: decodeURIComponent(name), reward };
  });
}
