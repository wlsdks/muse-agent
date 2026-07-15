#!/usr/bin/env node
// Signal-based work discovery for gap-scout: read the run-log traces Muse wrote
// to .muse/runs/*.jsonl, cluster the FAILING ones (ungrounded answers, failed
// runs) by frequency, and print ranked candidate work. The deterministic core
// is apps/cli/dist/run-log-analysis.js (behaviorally unit-tested) — this script
// is only the fs glob + print. Run: `node scripts/scout-signals.mjs [runsDir]`.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { analyzeRunLogSignals } from "../apps/cli/dist/run-log-analysis.js";
import { readTextOrDefault } from "./best-effort.mjs";

const runsDir = process.argv[2] ?? path.join(process.cwd(), ".muse", "runs");

async function readEvents(dir) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { events: [], missing: true };
  }
  const events = [];
  for (const file of files) {
    const raw = await readTextOrDefault(() => readFile(path.join(dir, file), "utf8"));
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        // Lift the answer text + retrieval up so the analyzer can drop empty (no-op)
        // answers AND tell an actionable grounding miss from a general-knowledge one.
        const answer = event?.response?.response;
        const retrieval = event?.response?.retrieval;
        events.push({
          ...event,
          ...(typeof answer === "string" ? { answer } : {}),
          ...(Array.isArray(retrieval) ? { retrieval } : {})
        });
      } catch {
        // a half-written line — skip, never crash the scout
      }
    }
  }
  return { events, fileCount: files.length, missing: false };
}

const { events, fileCount, missing } = await readEvents(runsDir);
if (missing) {
  console.log(`[scout-signals] no runs dir at ${runsDir} — no traces yet (fall back to codebase gap-scout).`);
  process.exit(0);
}

const clusters = analyzeRunLogSignals(events);
const labeled = events.filter((e) => e.grounded != null || typeof e.success === "boolean").length;

console.log(`[scout-signals] ${events.length} traces in ${fileCount} files (${labeled} labeled); ${clusters.length} failure clusters.`);
if (clusters.length === 0) {
  console.log("[scout-signals] no failure signal — clean board. Fall back to codebase/EXPANSION gap-scout (tier 2).");
  process.exit(0);
}
console.log("\nCandidate work (most-recurring failure first):");
for (const c of clusters) {
  console.log(`  - [${c.kind} ×${c.count}] ${c.topic}`);
  console.log(`      e.g. ${c.examples.slice(0, 2).map((m) => JSON.stringify(m)).join(" · ")}`);
}
