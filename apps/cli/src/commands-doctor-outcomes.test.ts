import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeRunOutcomes } from "@muse/proactivity";

import { formatRunOutcomes, readRunOutcomeEntries } from "./commands-doctor-outcomes.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true }))));

function entry(runId: string, grounded: string, recordedAt: string, lineIndex = 0) {
  return { fileRunId: runId, grounded, lineIndex, message: "office vpn", recordedAt, runId, type: "chat.completed" };
}

describe("formatRunOutcomes", () => {
  it("reports insufficient provenance without rendering zero percent as success", () => {
    const out = formatRunOutcomes(analyzeRunOutcomes([], { now: new Date("2026-07-22T00:00:00.000Z") }));
    expect(out).toContain("no decision-grade unique runs yet");
    expect(out).not.toContain("0%");
    expect(out).toContain("technical grounding diagnostics, not personal usefulness");
  });

  it("renders the decision-grade denominator, source, window, freshness, and safe action", () => {
    const out = formatRunOutcomes(analyzeRunOutcomes([
      entry("run_a", "grounded", "2026-07-21T00:00:00.000Z"),
      entry("run_b", "error", "2026-07-22T00:00:00.000Z")
    ], { now: new Date("2026-07-22T12:00:00.000Z") }));

    expect(out).toContain("2 unique graded runs");
    expect(out).toContain("technical failure-rate 50%");
    expect(out).toContain("evidence: unclassified · source: run-grounding-log@1");
    expect(out).toContain("window: 2026-07-21T00:00:00.000Z → 2026-07-22T00:00:00.000Z");
    expect(out).toContain("freshness: fresh");
    expect(out).toContain("action: muse doctor --run-outcomes");
  });

  it("marks old measurements stale", () => {
    const out = formatRunOutcomes(analyzeRunOutcomes([
      entry("run_old", "ungrounded", "2026-07-01T00:00:00.000Z")
    ], { now: new Date("2026-07-22T00:00:00.000Z") }));
    expect(out).toContain("freshness: stale");
  });
});

describe("readRunOutcomeEntries", () => {
  it("preserves legacy lines while attaching exact file/run provenance for the new metric", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-run-metric-"));
    roots.push(root);
    const runs = join(root, ".muse", "runs");
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, "run_exact.jsonl"), [
      JSON.stringify({ grounded: "abstain", message: "legacy line" }),
      JSON.stringify({ grounded: "error", message: "canonical", recordedAt: "2026-07-22T00:00:00.000Z", runId: "run_exact", type: "chat.completed" })
    ].join("\n"), "utf8");

    const entries = await readRunOutcomeEntries(root);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ fileRunId: "run_exact", grounded: "abstain", lineIndex: 0 });
    expect(entries[1]).toMatchObject({ fileRunId: "run_exact", grounded: "error", lineIndex: 1, runId: "run_exact", type: "chat.completed" });
  });
});
