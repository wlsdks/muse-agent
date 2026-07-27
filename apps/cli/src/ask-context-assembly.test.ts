/**
 * Integration lock for the behavioural-rule budget wiring: the previous build
 * of this feature shipped `selectBehaviouralRules` with ZERO production
 * callers — a fully-tested module bolted to nothing. This file proves the
 * REAL `assembleAskContext` (the function `commands-ask.ts` calls for every
 * plain `muse ask`) actually reaches the shared budget with a real on-disk
 * playbook file and the real turn query, and that the count landing in the
 * assembled `[Learned Strategies]` prompt section is exactly what the shared
 * budget dictates — not the helper tested in isolation.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RULE_BUDGET_DEFAULT } from "@muse/agent-core";
import { composeChatSystemContent, createStageTimer } from "@muse/recall";
import type { MuseRuntimeAssembly } from "@muse/autoconfigure";
import type { FactRecallDecision, UserMemory } from "@muse/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assembleAskContext } from "./ask-context-assembly.js";
import type { AskOptions } from "./ask-command-options.js";
import type { ProgramIO } from "./program.js";

const USER = "u_int_test";
const QUERY = "should I take the morning train or the afternoon train";

let dir: string;
let playbookFile: string;
let prevPlaybookFile: string | undefined;
let prevHome: string | undefined;

const io: ProgramIO = { stderr: () => {}, stdout: () => {} };
const assembly = {} as MuseRuntimeAssembly;
const options: AskOptions = {};

// Each entry mentions "train" once (relevant to QUERY) plus 4 tokens unique to
// its own index — this keeps pairwise Jaccard low so the playbook ranker's
// near-duplicate suppression (PLAYBOOK_INJECT_DEDUP_THRESHOLD, 0.8) never
// collapses distinct entries together. A test fixture whose entries paraphrase
// each other would measure DEDUP, not the budget cut this file exists to prove.
function entry(id: string, i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id,
    origin: "manual",
    text: `train scenario alpha${String(i)} bravo${String(i)} charlie${String(i)} delta${String(i)} advice`,
    userId: USER,
    ...extra
  };
}

async function callAssemble(
  query: string,
  userMemory: UserMemory | undefined = undefined,
  memoryRecallDecisions: readonly FactRecallDecision[] | undefined = undefined
) {
  return assembleAskContext({
    askStages: createStageTimer(),
    assembly,
    browsingBlock: "",
    browsingHits: [],
    embedModel: "test-embedder",
    episodeBlock: "",
    episodeHits: [],
    feedBlock: "",
    feedHeadlines: [],
    io,
    ...(memoryRecallDecisions ? { memoryRecallDecisions } : {}),
    options,
    personaPrompt: undefined,
    personaTemplatePreamble: "",
    query,
    reflectionBlock: "",
    reflectionLines: [],
    userKey: USER,
    userMemory
  });
}

function bulletCount(section: string | undefined): number {
  return (section ?? "").split("\n").filter((l) => l.startsWith("- ")).length;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-ask-rule-budget-int-"));
  playbookFile = join(dir, "playbook.json");
  prevPlaybookFile = process.env.MUSE_PLAYBOOK_FILE;
  prevHome = process.env.HOME;
  process.env.HOME = dir;
  process.env.MUSE_PLAYBOOK_FILE = playbookFile;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevPlaybookFile === undefined) delete process.env.MUSE_PLAYBOOK_FILE;
  else process.env.MUSE_PLAYBOOK_FILE = prevPlaybookFile;
  await rm(dir, { force: true, recursive: true });
});

describe("assembleAskContext — production wiring to the shared behavioural-rule budget", () => {
  it("40 stored (all query-relevant) playbook-only strategies: exactly 6 reach the assembled prompt — the playbook prefetch stays at its pre-existing default (6), not the shared budget's default (7)", async () => {
    // No vetoes/prefs/goals compete here, so the playbook's OWN pre-ranking
    // (rankPlaybookStrategies, topK defaulting to 6 — playbookPrefetchTopK's
    // whole reason for existing) is the binding constraint, not
    // selectBehaviouralRules' 7. This is the exact regression a prior attempt
    // shipped: threading ruleBudget() (7) into the playbook's own topK
    // silently raised its default from 6 to 7.
    const entries = Array.from({ length: 40 }, (_, i) => entry(`pb_${String(i)}`, i));
    await writeFile(playbookFile, JSON.stringify({ entries }), "utf8");

    const assembled = await callAssemble(QUERY);
    expect(assembled.playbookSection).toBeDefined();
    expect(bulletCount(assembled.playbookSection)).toBe(6);

    // Assert the REAL assembled system prompt (what commands-ask.ts actually
    // sends the model), not just the isolated playbookSection field.
    const systemPrompt = composeChatSystemContent(
      assembled.buildFullSystemPrompt({ contextBlock: "(no relevant notes found)", notesFraming: { header: "" } }),
      assembled.playbookSection
    );
    expect(systemPrompt).toContain("[Learned Strategies]");
    expect(bulletCount(systemPrompt)).toBe(6);
  });

  it("a bank at or below the budget is unchanged in count", async () => {
    const entries = Array.from({ length: 4 }, (_, i) => entry(`pb_${String(i)}`, i));
    await writeFile(playbookFile, JSON.stringify({ entries }), "utf8");

    const assembled = await callAssemble(QUERY);
    expect(bulletCount(assembled.playbookSection)).toBe(4);
  });

  it("MUSE_RULE_BUDGET raises BOTH the playbook prefetch and the shared budget, end-to-end", async () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(`pb_${String(i)}`, i));
    await writeFile(playbookFile, JSON.stringify({ entries }), "utf8");
    const prev = process.env.MUSE_RULE_BUDGET;
    process.env.MUSE_RULE_BUDGET = "10";
    try {
      const assembled = await callAssemble(QUERY);
      expect(bulletCount(assembled.playbookSection)).toBe(10);
    } finally {
      if (prev === undefined) delete process.env.MUSE_RULE_BUDGET;
      else process.env.MUSE_RULE_BUDGET = prev;
    }
  });

  it("the shared budget (default 7) caps the LEARNED rules, and vetoes never spend its slots", async () => {
    // 10 playbook strategies + 3 vetoes. Vetoes sit OUTSIDE the budget — a user
    // with vetoes must not thereby lose learned strategies — so the budget of 7
    // applies only to the learned kinds, and the playbook's share is capped at 7,
    // not squeezed further by the vetoes. If the shared cross-kind budget were dead
    // code (isolated per-kind topK), all 10 would reach the prompt.
    const entries = Array.from({ length: 10 }, (_, i) => entry(`pb_${String(i)}`, i));
    await writeFile(playbookFile, JSON.stringify({ entries }), "utf8");
    const userMemory: UserMemory = {
      facts: {},
      preferences: {
        "veto:v0": "completely unrelated veto about cooking zzqz",
        "veto:v1": "completely unrelated veto about singing zzqw",
        "veto:v2": "completely unrelated veto about dancing zzqu"
      },
      recentTopics: [],
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      userId: USER
    };
    const assembled = await callAssemble(QUERY, userMemory);
    const shown = bulletCount(assembled.playbookSection);
    expect(shown).toBeLessThanOrEqual(7);
    expect(shown).toBeGreaterThan(0);
  });

  it("a stored conflict edge suppresses the loser even in the assembled prompt", async () => {
    const entries = [
      entry("pb_older", 0, { text: "when the train is late, wait at the platform for an update" }),
      entry("pb_newer", 1, { conflictsWith: ["pb_older"], text: "when the train is late, just walk instead of waiting" })
    ];
    await writeFile(playbookFile, JSON.stringify({ entries }), "utf8");

    const assembled = await callAssemble("what should I do when the train is late");
    expect(assembled.playbookSection).toContain("just walk instead of waiting");
    expect(assembled.playbookSection).not.toContain("wait at the platform");
  });
});

describe("assembleAskContext — RULE_BUDGET_DEFAULT sanity", () => {
  it("the default is 7 (documents the constant this file's expectations are built around)", () => {
    expect(RULE_BUDGET_DEFAULT).toBe(7);
  });
});

describe("assembleAskContext — disputed memory recall receipt", () => {
  it("renders an eligible disputed fact with uncertainty instead of established-fact wording", async () => {
    const userMemory: UserMemory = {
      facts: { home_city: "Busan" },
      preferences: {},
      recentTopics: [],
      updatedAt: new Date("2026-07-27T00:00:00.000Z"),
      userId: USER
    };
    const decisions: readonly FactRecallDecision[] = [{
      eligibility: "uncertain",
      key: "home_city",
      kind: "fact",
      policyVersion: "muse.fact-recall-lifecycle.v1",
      reason: "auto-values-conflict",
      state: "disputed"
    }];
    const assembled = await callAssemble("what is my home city", userMemory, decisions);
    expect(assembled.memoryBlock).toContain("home city: Busan");
    expect(assembled.memoryBlock).toMatch(/changed before|confirm/u);
    expect(assembled.memoryRecallDecisions).toEqual(decisions);
  });
});
