import { mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import type { PlaybookEntry, StoredReflection, WeaknessEntry } from "@muse/stores";
import type { Skill } from "@muse/skills";
import { InMemoryRuntimeSettingsStore, RuntimeSettings } from "@muse/runtime-settings";
import { describe, expect, it } from "vitest";

import { CONSOLIDATE_IDLE_FLAG } from "./consolidate-idle-flag.js";
import { parseRewardDelta, registerSelfImprovementRoutes, shapePlaybook, shapeReflections, shapeSelfImprovementStatus, shapeSkills, shapeWeaknesses } from "./self-improvement-routes.js";

describe("parseRewardDelta", () => {
  it("returns a positive finite number when delta is valid", () => {
    expect(parseRewardDelta({ delta: 2 })).toBe(2);
  });

  it("returns a negative finite number when delta is valid", () => {
    expect(parseRewardDelta({ delta: -1 })).toBe(-1);
  });

  it("returns a fractional finite number when delta is valid", () => {
    expect(parseRewardDelta({ delta: 0.5 })).toBe(0.5);
  });

  it("returns undefined for missing delta field", () => {
    expect(parseRewardDelta({})).toBeUndefined();
  });

  it("returns undefined when delta is 0", () => {
    expect(parseRewardDelta({ delta: 0 })).toBeUndefined();
  });

  it("returns undefined when delta is a string", () => {
    expect(parseRewardDelta({ delta: "2" })).toBeUndefined();
  });

  it("returns undefined when delta is NaN", () => {
    expect(parseRewardDelta({ delta: NaN })).toBeUndefined();
  });

  it("returns undefined when delta is Infinity", () => {
    expect(parseRewardDelta({ delta: Infinity })).toBeUndefined();
  });

  it("returns undefined when delta is -Infinity", () => {
    expect(parseRewardDelta({ delta: -Infinity })).toBeUndefined();
  });

  it("returns undefined when body is null", () => {
    expect(parseRewardDelta(null)).toBeUndefined();
  });

  it("returns undefined when body is undefined", () => {
    expect(parseRewardDelta(undefined)).toBeUndefined();
  });

  it("returns undefined when body is a number (not an object)", () => {
    expect(parseRewardDelta(42)).toBeUndefined();
  });

  it("returns undefined when body is an array", () => {
    expect(parseRewardDelta([{ delta: 1 }])).toBeUndefined();
  });
});

function entry(partial: Partial<WeaknessEntry> & { topic: string; count: number; lastSeen: string }): WeaknessEntry {
  return {
    axis: "grounding-gap",
    firstSeen: "2026-06-01T00:00:00Z",
    ...partial
  } as WeaknessEntry;
}

describe("shapeWeaknesses", () => {
  it("orders by count descending, then most-recent lastSeen", () => {
    const out = shapeWeaknesses([
      entry({ topic: "a", count: 2, lastSeen: "2026-06-10T00:00:00Z" }),
      entry({ topic: "b", count: 5, lastSeen: "2026-06-02T00:00:00Z" }),
      entry({ topic: "c", count: 2, lastSeen: "2026-06-20T00:00:00Z" })
    ]);
    expect(out.entries.map((e) => e.topic)).toEqual(["b", "c", "a"]);
  });

  it("reports the total and never drops an entry", () => {
    const out = shapeWeaknesses([
      entry({ topic: "a", count: 1, lastSeen: "2026-06-10T00:00:00Z" }),
      entry({ topic: "b", count: 1, lastSeen: "2026-06-11T00:00:00Z" })
    ]);
    expect(out.total).toBe(2);
    expect(out.entries).toHaveLength(2);
  });

  it("normalizes absent hint/pKnown to null (JSON-friendly), present ones pass through", () => {
    const out = shapeWeaknesses([
      entry({ topic: "a", count: 1, lastSeen: "2026-06-10T00:00:00Z" }),
      entry({ topic: "b", count: 1, lastSeen: "2026-06-10T00:00:00Z", hint: "add a note", pKnown: 0.4 })
    ]);
    const a = out.entries.find((e) => e.topic === "a")!;
    const b = out.entries.find((e) => e.topic === "b")!;
    expect(a.hint).toBeNull();
    expect(a.pKnown).toBeNull();
    expect(b.hint).toBe("add a note");
    expect(b.pKnown).toBe(0.4);
  });

  it("preserves a pKnown of exactly 0 (a real value, not 'absent')", () => {
    const out = shapeWeaknesses([entry({ topic: "a", count: 1, lastSeen: "2026-06-10T00:00:00Z", pKnown: 0 })]);
    expect(out.entries[0]!.pKnown).toBe(0);
  });

  it("an empty ledger is total 0, not a crash", () => {
    expect(shapeWeaknesses([])).toEqual({ total: 0, entries: [] });
  });
});

function pbEntry(partial: Partial<PlaybookEntry> & { id: string; text: string; createdAt: string }): PlaybookEntry {
  return {
    userId: "u1",
    ...partial
  } as PlaybookEntry;
}

describe("shapePlaybook", () => {
  it("orders by reward DESC, tie-break by recency DESC", () => {
    const out = shapePlaybook([
      pbEntry({ id: "a", text: "a", createdAt: "2026-06-10T00:00:00Z", reward: 1 }),
      pbEntry({ id: "b", text: "b", createdAt: "2026-06-02T00:00:00Z", reward: 3 }),
      pbEntry({ id: "c", text: "c", createdAt: "2026-06-15T00:00:00Z", reward: 1 })
    ]);
    expect(out.entries.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("tie-breaks by lastReinforcedAt when present (newest first)", () => {
    const out = shapePlaybook([
      pbEntry({ id: "a", text: "a", createdAt: "2026-06-01T00:00:00Z", reward: 2, lastReinforcedAt: "2026-06-05T00:00:00Z" }),
      pbEntry({ id: "b", text: "b", createdAt: "2026-06-01T00:00:00Z", reward: 2, lastReinforcedAt: "2026-06-20T00:00:00Z" })
    ]);
    expect(out.entries.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("treats absent reward as 0 for ordering", () => {
    const out = shapePlaybook([
      pbEntry({ id: "a", text: "a", createdAt: "2026-06-10T00:00:00Z" }),
      pbEntry({ id: "b", text: "b", createdAt: "2026-06-20T00:00:00Z", reward: 0 }),
      pbEntry({ id: "c", text: "c", createdAt: "2026-06-05T00:00:00Z", reward: 1 })
    ]);
    expect(out.entries[0]!.id).toBe("c");
    const zeroIds = out.entries.slice(1).map((e) => e.id);
    expect(zeroIds).toContain("a");
    expect(zeroIds).toContain("b");
    expect(zeroIds[0]).toBe("b");
  });

  it("reports total and never drops an entry", () => {
    const out = shapePlaybook([
      pbEntry({ id: "a", text: "a", createdAt: "2026-06-10T00:00:00Z" }),
      pbEntry({ id: "b", text: "b", createdAt: "2026-06-11T00:00:00Z" })
    ]);
    expect(out.total).toBe(2);
    expect(out.entries).toHaveLength(2);
  });

  it("normalizes absent tag/origin/source to null, present values pass through", () => {
    const out = shapePlaybook([
      pbEntry({ id: "a", text: "a", createdAt: "2026-06-10T00:00:00Z" }),
      pbEntry({ id: "b", text: "b", createdAt: "2026-06-10T00:00:00Z", tag: "scheduling", origin: "grounded", source: "because X" })
    ]);
    const a = out.entries.find((e) => e.id === "a")!;
    const b = out.entries.find((e) => e.id === "b")!;
    expect(a.tag).toBeNull();
    expect(a.origin).toBeNull();
    expect(a.source).toBeNull();
    expect(b.tag).toBe("scheduling");
    expect(b.origin).toBe("grounded");
    expect(b.source).toBe("because X");
  });

  it("normalizes absent reward to 0, absent probation to false, absent timesObserved to 1", () => {
    const out = shapePlaybook([pbEntry({ id: "a", text: "a", createdAt: "2026-06-10T00:00:00Z" })]);
    expect(out.entries[0]!.reward).toBe(0);
    expect(out.entries[0]!.probation).toBe(false);
    expect(out.entries[0]!.timesObserved).toBe(1);
  });

  it("preserves present reward/probation/timesObserved values", () => {
    const out = shapePlaybook([pbEntry({ id: "a", text: "a", createdAt: "2026-06-10T00:00:00Z", reward: 3, probation: true, timesObserved: 5 })]);
    expect(out.entries[0]!.reward).toBe(3);
    expect(out.entries[0]!.probation).toBe(true);
    expect(out.entries[0]!.timesObserved).toBe(5);
  });

  it("an empty playbook is total 0, not a crash", () => {
    expect(shapePlaybook([])).toEqual({ total: 0, entries: [] });
  });
});

function skillEntry(partial: { name: string; description?: string; source?: string }): Skill {
  return {
    name: partial.name,
    description: partial.description ?? "",
    frontmatter: { name: partial.name, description: partial.description ?? "" },
    body: "",
    sourceInfo: { source: (partial.source ?? "authored") as Skill["sourceInfo"]["source"], filePath: "", baseDir: "" }
  };
}

describe("shapeSkills", () => {
  it("orders by reward DESC, tie-break name ASC", () => {
    const skills = [
      skillEntry({ name: "bravo" }),
      skillEntry({ name: "alpha" }),
      skillEntry({ name: "gamma" })
    ];
    const rewards: Record<string, number> = { bravo: 2, alpha: 2, gamma: 5 };
    const out = shapeSkills(skills, rewards);
    expect(out.entries.map((e) => e.name)).toEqual(["gamma", "alpha", "bravo"]);
  });

  it("treats absent reward as 0 for ordering", () => {
    const skills = [
      skillEntry({ name: "z-zero" }),
      skillEntry({ name: "a-zero" }),
      skillEntry({ name: "positive" })
    ];
    const rewards: Record<string, number> = { positive: 3 };
    const out = shapeSkills(skills, rewards);
    expect(out.entries[0]!.name).toBe("positive");
    expect(out.entries[0]!.reward).toBe(3);
    expect(out.entries[1]!.name).toBe("a-zero");
    expect(out.entries[1]!.reward).toBe(0);
    expect(out.entries[2]!.name).toBe("z-zero");
    expect(out.entries[2]!.reward).toBe(0);
  });

  it("marks avoided=true when reward <= -4, false otherwise, false when absent", () => {
    const skills = [
      skillEntry({ name: "deep-avoided" }),
      skillEntry({ name: "threshold-avoided" }),
      skillEntry({ name: "borderline" }),
      skillEntry({ name: "absent" })
    ];
    const rewards: Record<string, number> = { "deep-avoided": -5, "threshold-avoided": -4, borderline: -3 };
    const out = shapeSkills(skills, rewards);
    const byName = Object.fromEntries(out.entries.map((e) => [e.name, e]));
    expect(byName["deep-avoided"]!.avoided).toBe(true);
    expect(byName["threshold-avoided"]!.avoided).toBe(true);
    expect(byName["borderline"]!.avoided).toBe(false);
    expect(byName["absent"]!.avoided).toBe(false);
  });

  it("reports total = skills.length and never drops an entry", () => {
    const skills = [skillEntry({ name: "a" }), skillEntry({ name: "b" }), skillEntry({ name: "c" })];
    const out = shapeSkills(skills, {});
    expect(out.total).toBe(3);
    expect(out.entries).toHaveLength(3);
  });

  it("projects sanitized zero/null usage defaults and durable telemetry", () => {
    const out = shapeSkills(
      [skillEntry({ name: "used" }), skillEntry({ name: "new" })],
      {},
      { used: { lastActivity: "2026-08-09T00:00:00.000Z", useCount: 2, viewCount: 1 } }
    );
    expect(out.entries.find((entry) => entry.name === "used")).toMatchObject({
      lastActivity: "2026-08-09T00:00:00.000Z",
      useCount: 2,
      viewCount: 1
    });
    expect(out.entries.find((entry) => entry.name === "new")).toMatchObject({
      lastActivity: null,
      useCount: 0,
      viewCount: 0
    });
  });

  it("an empty skill list is total 0, not a crash", () => {
    expect(shapeSkills([], {})).toEqual({ total: 0, entries: [] });
  });
});

describe("GET /api/self-improvement/skills usage projection", () => {
  it("joins sidecar evidence to the canonical authored skill list", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-self-improvement-skills-"));
    const authoredDir = join(root, "authored");
    mkdirSync(join(authoredDir, "release"), { recursive: true });
    await writeFile(join(authoredDir, "release", "SKILL.md"), "---\nname: release\ndescription: Release safely\n---\nSteps.\n", "utf8");
    const usageFile = join(root, "skill-usage.json");
    await writeFile(usageFile, JSON.stringify({
      skills: { release: { lastActivity: "2026-08-09T00:00:00.000Z", useCount: 2, viewCount: 3 } },
      version: 1
    }), "utf8");
    const server = Fastify({ logger: false });
    registerSelfImprovementRoutes(server, {
      authService: undefined,
      authoredSkillsDir: authoredDir,
      configured: true,
      env: {},
      learnQueueFile: join(root, "learn.jsonl"),
      learningPauseFile: join(root, "pause.json"),
      playbookFile: join(root, "playbook.json"),
      reflectionsFile: join(root, "reflections.json"),
      skillRewardsFile: join(root, "rewards.json"),
      skillUsageFile: usageFile,
      weaknessesFile: join(root, "weaknesses.json")
    });

    const response = await server.inject({ method: "GET", url: "/api/self-improvement/skills" });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0]).toMatchObject({ lastActivity: "2026-08-09T00:00:00.000Z", useCount: 2, viewCount: 3 });
    await server.close();
  });
});

function reflectionEntry(partial: Partial<StoredReflection> & { id: string; createdAtMs: number }): StoredReflection {
  return {
    insight: "Insight text",
    sourceIds: [],
    supportCount: 1,
    ...partial
  } as StoredReflection;
}

describe("shapeReflections", () => {
  it("orders newest-first by createdAtMs (proves listReflections is applied, not raw order)", () => {
    const out = shapeReflections([
      reflectionEntry({ id: "old", createdAtMs: 1000 }),
      reflectionEntry({ id: "newest", createdAtMs: 3000 }),
      reflectionEntry({ id: "mid", createdAtMs: 2000 })
    ]);
    expect(out.entries.map((e) => e.id)).toEqual(["newest", "mid", "old"]);
  });

  it("sourceCount equals sourceIds.length", () => {
    const out = shapeReflections([
      reflectionEntry({ id: "two-sources", createdAtMs: 2000, sourceIds: ["ep1", "ep2"] }),
      reflectionEntry({ id: "zero-sources", createdAtMs: 1000, sourceIds: [] })
    ]);
    const byId = Object.fromEntries(out.entries.map((e) => [e.id, e]));
    expect(byId["two-sources"]!.sourceCount).toBe(2);
    expect(byId["zero-sources"]!.sourceCount).toBe(0);
  });

  it("total equals reflections.length and never drops entries", () => {
    const out = shapeReflections([
      reflectionEntry({ id: "a", createdAtMs: 1000 }),
      reflectionEntry({ id: "b", createdAtMs: 2000 }),
      reflectionEntry({ id: "c", createdAtMs: 3000 })
    ]);
    expect(out.total).toBe(3);
    expect(out.entries).toHaveLength(3);
  });

  it("maps insight and supportCount through unchanged", () => {
    const out = shapeReflections([
      reflectionEntry({ id: "x", createdAtMs: 1000, insight: "The user prefers morning notes", supportCount: 7 })
    ]);
    expect(out.entries[0]!.insight).toBe("The user prefers morning notes");
    expect(out.entries[0]!.supportCount).toBe(7);
  });

  it("an empty list is total 0, not a crash", () => {
    expect(shapeReflections([])).toEqual({ total: 0, entries: [] });
  });
});

describe("shapeSelfImprovementStatus", () => {
  it("reports an unconfigured loop without implying activity", () => {
    expect(shapeSelfImprovementStatus({
      configured: false,
      enabled: false,
      paused: false,
      pendingCorrections: 0
    })).toEqual({
      configured: false,
      enabled: false,
      paused: false,
      pendingCorrections: 0,
      state: "unconfigured",
      lastObservedAtIso: null,
      lastDecision: null
    });
  });

  it("keeps a configured but disabled daemon dormant and preserves its safe tick snapshot", () => {
    expect(shapeSelfImprovementStatus({
      configured: true,
      enabled: false,
      paused: true,
      pendingCorrections: 2,
      daemonStatus: {
        lastDecision: "disabled",
        lastObservedAtIso: "2026-08-08T00:00:00.000Z"
      }
    })).toMatchObject({
      configured: true,
      enabled: false,
      paused: true,
      pendingCorrections: 2,
      state: "dormant",
      lastDecision: "disabled"
    });
  });
});

describe("GET /api/self-improvement/status", () => {
  it("counts valid queue events, skips malformed lines, and treats missing pause state as unpaused", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-self-improvement-status-"));
    const queueFile = join(root, "learn-queue.jsonl");
    await writeFile(queueFile, [
      "not-json",
      JSON.stringify({
        correction: "Prefer bullets",
        enqueuedAtMs: 1,
        id: "learn-1",
        priorAnswer: "A paragraph",
        userId: "u1"
      }),
      JSON.stringify({ id: "incomplete" })
    ].join("\n"));
    const server = Fastify({ logger: false });
    registerSelfImprovementRoutes(server, {
      authService: undefined,
      authoredSkillsDir: root,
      configured: true,
      env: { [CONSOLIDATE_IDLE_FLAG]: "true" },
      learnQueueFile: queueFile,
      learningPauseFile: join(root, "missing-pause.json"),
      playbookFile: join(root, "playbook.json"),
      reflectionsFile: join(root, "reflections.json"),
      skillRewardsFile: join(root, "skill-rewards.json"),
      weaknessesFile: join(root, "weaknesses.json")
    });

    const response = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: true,
      enabled: true,
      paused: false,
      pendingCorrections: 1,
      state: "dormant",
      lastObservedAtIso: null,
      lastDecision: null
    });
    await server.close();
  });

  it("uses a valid runtime setting before env and safely falls back when the runtime setting is malformed", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-self-improvement-runtime-status-"));
    const runtimeSettings = new RuntimeSettings(new InMemoryRuntimeSettingsStore());
    await runtimeSettings.set({ key: CONSOLIDATE_IDLE_FLAG, type: "boolean", value: "false" });
    const server = Fastify({ logger: false });
    registerSelfImprovementRoutes(server, {
      authService: undefined,
      authoredSkillsDir: root,
      configured: true,
      env: { [CONSOLIDATE_IDLE_FLAG]: "true" },
      learnQueueFile: join(root, "missing-queue.jsonl"),
      learningPauseFile: join(root, "missing-pause.json"),
      playbookFile: join(root, "playbook.json"),
      reflectionsFile: join(root, "reflections.json"),
      runtimeSettings,
      skillRewardsFile: join(root, "skill-rewards.json"),
      weaknessesFile: join(root, "weaknesses.json")
    });

    const overridden = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
    expect(overridden.json().enabled).toBe(false);
    await runtimeSettings.set({ key: CONSOLIDATE_IDLE_FLAG, type: "boolean", value: "maybe" });
    const malformed = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
    expect(malformed.json().enabled).toBe(true);
    await server.close();
  });

  it("fails closed when runtime settings cannot be read, even if the environment enables it", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-self-improvement-runtime-status-failure-"));
    const runtimeSettings = new RuntimeSettings({
      delete: () => undefined,
      find: () => {
        throw new Error("runtime settings unavailable");
      },
      findValue: () => undefined,
      list: () => [],
      upsert: () => {
        throw new Error("not used");
      }
    });
    const server = Fastify({ logger: false });
    registerSelfImprovementRoutes(server, {
      authService: undefined,
      authoredSkillsDir: root,
      configured: true,
      env: { [CONSOLIDATE_IDLE_FLAG]: "true" },
      learnQueueFile: join(root, "missing-queue.jsonl"),
      learningPauseFile: join(root, "missing-pause.json"),
      playbookFile: join(root, "playbook.json"),
      reflectionsFile: join(root, "reflections.json"),
      runtimeSettings,
      skillRewardsFile: join(root, "skill-rewards.json"),
      weaknessesFile: join(root, "weaknesses.json")
    });

    const response = await server.inject({ method: "GET", url: "/api/self-improvement/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      enabled: false,
      state: "dormant"
    });
    await server.close();
  });
});
