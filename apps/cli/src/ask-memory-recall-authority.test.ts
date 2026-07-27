import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { BeliefProvenance, UserMemory } from "@muse/memory";
import { buildMusePersona } from "@muse/recall";

import { resolveAskMemoryRecallAuthority } from "./ask-memory-recall-authority.js";

const USER = "owner";

function memory(overrides: Partial<UserMemory> = {}): UserMemory {
  return {
    facts: { home_city: "Busan", pet: "cat" },
    preferences: {
      editor: "Zed",
      "goal:ship": "Release Muse",
      "veto:no-send": "Never send without approval"
    },
    recentTopics: [],
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    userId: USER,
    ...overrides
  };
}

function entry(overrides: Partial<BeliefProvenance>): BeliefProvenance {
  return {
    key: "home_city",
    kind: "fact",
    learnedAt: "2026-07-20T00:00:00.000Z",
    source: "auto",
    userId: USER,
    value: "Busan",
    ...overrides
  };
}

function store(entries: readonly BeliefProvenance[]) {
  return { query: async () => entries };
}

describe("resolveAskMemoryRecallAuthority", () => {
  it("preserves the exact memory snapshot when no provenance changes eligibility", async () => {
    const stored = memory();
    const result = await resolveAskMemoryRecallAuthority(stored, USER, {
      provenanceStore: store([])
    });
    expect(result.status).toBe("verified");
    expect(result.memory).toBe(stored);
    expect(result.decisions.every((decision) =>
      decision.state === "active" && decision.eligibility === "eligible"
    )).toBe(true);
  });

  it("removes tombstoned facts and preferences before persona, matching, or citations", async () => {
    const result = await resolveAskMemoryRecallAuthority(memory(), USER, {
      provenanceStore: store([
        entry({ key: "home_city", value: "Busan" }),
        entry({ key: "home_city", learnedAt: "2026-07-21T00:00:00.000Z", retraction: true, source: "user", value: "" }),
        entry({ key: "editor", kind: "preference", value: "Zed" }),
        entry({ key: "editor", kind: "preference", learnedAt: "2026-07-21T00:00:00.000Z", retraction: true, source: "user", value: "" })
      ])
    });

    expect(result.status).toBe("verified");
    expect(result.memory?.facts).toEqual({ pet: "cat" });
    expect(result.memory?.preferences).toEqual({
      "goal:ship": "Release Muse",
      "veto:no-send": "Never send without approval"
    });
    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "home_city", state: "deleted", eligibility: "ineligible" }),
      expect.objectContaining({ key: "editor", state: "deleted", eligibility: "ineligible" })
    ]));
    const persona = buildMusePersona(result.memory!, USER);
    expect(persona).not.toContain("Busan");
    expect(persona).not.toContain("Zed");
    expect(persona).toContain("Never send without approval");
  });

  it("excludes a stale flat-store value when newer authoritative provenance supersedes it", async () => {
    const result = await resolveAskMemoryRecallAuthority(
      memory({ facts: { home_city: "Seoul" } }),
      USER,
      {
        provenanceStore: store([
          entry({ value: "Seoul", learnedAt: "2026-07-19T00:00:00.000Z" }),
          entry({ value: "Busan", learnedAt: "2026-07-20T00:00:00.000Z", source: "user" })
        ])
      }
    );
    expect(result.memory?.facts).toEqual({});
    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "superseded", eligibility: "ineligible" })
    ]));
  });

  it("retains an auto-conflicted current value only with an explicit disputed receipt", async () => {
    const result = await resolveAskMemoryRecallAuthority(
      memory({ facts: { home_city: "Busan" } }),
      USER,
      {
        provenanceStore: store([
          entry({ value: "Seoul", learnedAt: "2026-07-19T00:00:00.000Z" }),
          entry({ value: "Busan", learnedAt: "2026-07-20T00:00:00.000Z" })
        ])
      }
    );
    expect(result.memory?.facts).toEqual({ home_city: "Busan" });
    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "disputed", eligibility: "uncertain" })
    ]));
  });

  it("fails closed when provenance authority cannot be read but preserves veto and goal rules", async () => {
    const result = await resolveAskMemoryRecallAuthority(memory(), USER, {
      provenanceStore: { query: async () => { throw new Error("wrong key"); } }
    });
    expect(result.status).toBe("unavailable");
    expect(result.memory?.facts).toEqual({});
    expect(result.memory?.preferences).toEqual({
      "goal:ship": "Release Muse",
      "veto:no-send": "Never send without approval"
    });
    expect(result.decisions.every((decision) =>
      decision.state === "disputed"
      && decision.eligibility === "ineligible"
      && decision.reason === "authority-unavailable"
    )).toBe(true);
  });

  it("fails closed through the production inspector for corrupt JSON and excluded malformed retractions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-recall-authority-corrupt-"));
    const file = join(dir, "belief-provenance.json");
    const env = { ...process.env, MUSE_BELIEF_PROVENANCE_FILE: file };
    const malformedRetraction = {
      entries: [{
        key: "home_city",
        kind: "fact",
        learnedAt: "2026-07-21T00:00:00.000Z",
        retraction: true,
        source: "user",
        userId: USER
      }]
    };
    const invalidRetractionType = {
      entries: [{
        key: "home_city",
        kind: "fact",
        learnedAt: "2026-07-21T00:00:00.000Z",
        retraction: "yes",
        source: "user",
        userId: USER,
        value: ""
      }]
    };
    try {
      for (const payload of ["{invalid-json", JSON.stringify(malformedRetraction), JSON.stringify(invalidRetractionType)]) {
        await writeFile(file, payload, "utf8");
        const result = await resolveAskMemoryRecallAuthority(memory(), USER, { env });
        expect(result.status).toBe("unavailable");
        expect(result.memory?.facts).toEqual({});
        expect(result.memory?.preferences).toEqual({
          "goal:ship": "Release Muse",
          "veto:no-send": "Never send without approval"
        });
        expect(result.decisions.every((decision) =>
          decision.reason === "authority-unavailable"
          && decision.eligibility === "ineligible"
        )).toBe(true);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
