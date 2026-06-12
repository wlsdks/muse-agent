/**
 * Assembled-path test: proves the Memp (arXiv 2508.06433) lifecycle fires
 * THROUGH the production buildPlaybookProvider projection, not just in isolation.
 *
 * Before the field carry-through fix, buildPlaybookProvider stripped
 * `reinforcements`/`decays`/`probation` → rankPlaybookStrategies saw only
 * legacy shapes → planStrategyLifecycle always returned "retain" → a
 * confidently-bad entry (0/8) was never deprecated in production.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAvoidedStrategy, rankPlaybookStrategies } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { buildPlaybookProvider } from "../src/context-engineering-builders.js";
import type { MuseEnvironment } from "../src/index.js";

function envWith(overrides: Record<string, string>): MuseEnvironment {
  return overrides as unknown as MuseEnvironment;
}

function writeTempPlaybook(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-pb-lifecycle-"));
  const file = join(dir, "playbook.json");
  writeFileSync(file, JSON.stringify({ entries }), "utf8");
  return file;
}

const BAD_ENTRY = {
  id: "pb_bad",
  userId: "stark",
  text: "confidently bad strategy",
  createdAt: "2026-01-01T00:00:00.000Z",
  reinforcements: 0,
  decays: 8
};

const GOOD_ENTRY = {
  id: "pb_good",
  userId: "stark",
  text: "keep emails short and direct",
  createdAt: "2026-01-01T00:00:00.000Z",
  reward: 2
};

const LEGACY_ENTRY = {
  id: "pb_legacy",
  userId: "stark",
  text: "use bullet points",
  tag: "formatting",
  createdAt: "2026-01-01T00:00:00.000Z",
  reward: 1
};

describe("buildPlaybookProvider — lifecycle fields carried through projection (arXiv 2508.06433)", () => {
  it("confident-bad entry (0 reinforcements / 8 decays) is excluded from ranked output via projection", async () => {
    const file = writeTempPlaybook([BAD_ENTRY, GOOD_ENTRY]);
    const provider = buildPlaybookProvider(envWith({ MUSE_PLAYBOOK_FILE: file }));
    expect(provider).toBeDefined();

    const strategies = await provider!.listStrategies("stark");
    expect(strategies).toHaveLength(2);

    // The projection must carry reinforcements+decays through so lifecycle fires:
    const bad = strategies.find((s) => s.text === BAD_ENTRY.text);
    expect(bad).toBeDefined();
    expect(bad!.reinforcements).toBe(0);
    expect(bad!.decays).toBe(8);

    // isAvoidedStrategy must fire on the projected shape:
    expect(isAvoidedStrategy(bad!)).toBe(true);

    // rankPlaybookStrategies must exclude it:
    const ranked = rankPlaybookStrategies(strategies, "bad strategy");
    expect(ranked.some((s) => s.text === BAD_ENTRY.text)).toBe(false);
    expect(ranked.some((s) => s.text === GOOD_ENTRY.text)).toBe(true);
  });

  it("legacy entry (no tally) passes through byte-identical — reward + tag preserved", async () => {
    const file = writeTempPlaybook([LEGACY_ENTRY]);
    const provider = buildPlaybookProvider(envWith({ MUSE_PLAYBOOK_FILE: file }));
    const strategies = await provider!.listStrategies("stark");

    expect(strategies).toHaveLength(1);
    const s = strategies[0]!;
    expect(s.text).toBe(LEGACY_ENTRY.text);
    expect(s.tag).toBe(LEGACY_ENTRY.tag);
    expect(s.reward).toBe(LEGACY_ENTRY.reward);
    // tally fields absent → lifecycle falls back to legacy path
    expect(s.reinforcements).toBeUndefined();
    expect(s.decays).toBeUndefined();
  });

  it("probation field is carried through the projection", async () => {
    const probationEntry = { ...GOOD_ENTRY, id: "pb_prob", text: "probation strategy", probation: true, reward: 2 };
    const file = writeTempPlaybook([probationEntry]);
    const provider = buildPlaybookProvider(envWith({ MUSE_PLAYBOOK_FILE: file }));
    const strategies = await provider!.listStrategies("stark");

    expect(strategies).toHaveLength(1);
    expect(strategies[0]!.probation).toBe(true);
    // probation without sufficient tally → non-injectable
    const ranked = rankPlaybookStrategies(strategies, "strategy");
    expect(ranked).toHaveLength(0);
  });
});

describe("counterfactual: WITHOUT tally carry-through, confident-bad is NOT excluded", () => {
  it("projection STRIPPED of tallies → isAvoidedStrategy returns false (lifecycle invisible)", () => {
    // Simulate what the OLD projection produced (fields stripped):
    const strippedBad = {
      text: BAD_ENTRY.text,
      // reinforcements/decays NOT present — the old { reward, tag, text }-only projection
    };
    // Without tallies, planStrategyLifecycle returns "retain" → not avoided
    expect(isAvoidedStrategy(strippedBad)).toBe(false);
    // And rankPlaybookStrategies would include it
    const ranked = rankPlaybookStrategies([strippedBad], "bad strategy");
    expect(ranked.some((s) => s.text === BAD_ENTRY.text)).toBe(true);
  });
});
