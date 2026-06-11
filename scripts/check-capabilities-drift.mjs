#!/usr/bin/env node
// Drift guard for docs/goals/CAPABILITIES.md — the loop's success metric.
//
// Each CAPABILITIES line cites the exact test / smoke file that PROVES
// the capability. If that file is renamed or deleted the line silently
// becomes a lie: the metric claims a proof that no longer exists. Prose
// review never catches this; a deterministic check does. Fail-close — a
// dangling citation exits non-zero so the regression sweep sees it.
//
// Runnable as `pnpm check:capabilities`. Zero deps.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CAP = join(ROOT, "docs/goals/CAPABILITIES.md");

// 1. Index every test-file basename under the workspace source roots.
const SOURCE_ROOTS = ["packages", "apps"];
const testFiles = new Set();
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.test\.tsx?$/.test(entry.name)) testFiles.add(entry.name);
  }
}
for (const root of SOURCE_ROOTS) {
  const p = join(ROOT, root);
  if (existsSync(p)) walk(p);
}

// 2. Parse capability lines; collect cited test files + script paths.
// A MISSING ledger is a clean baseline, not drift: docs/goals/CAPABILITIES.md
// was intentionally removed (the task-list docs are deliberately deleted per
// EXPANSION-PLAYBOOK). Before this guard, readFileSync ENOENT-crashed the
// process, which self-eval recorded as a permanent `capabilities: fail` — a red
// fitness signal the operator learns to ignore. No ledger ⇒ nothing to drift.
if (!existsSync(CAP)) {
  console.log("✓ CAPABILITIES.md absent — no capability ledger to drift-check (clean baseline).");
  process.exit(0);
}
const lines = readFileSync(CAP, "utf8").split("\n");
const TEST_RE = /\b([\w.-]+\.test\.tsx?)\b/g;
const SCRIPT_RE = /\b(scripts\/[\w.-]+\.mjs)\b/g;

const dangling = [];
let verifiedLines = 0;
lines.forEach((line, i) => {
  if (!line.startsWith("- [")) return;
  const lineNo = i + 1;
  let cited = false;
  for (const m of line.matchAll(TEST_RE)) {
    cited = true;
    if (!testFiles.has(m[1])) dangling.push({ lineNo, kind: "test file", ref: m[1] });
  }
  for (const m of line.matchAll(SCRIPT_RE)) {
    cited = true;
    if (!existsSync(join(ROOT, m[1]))) dangling.push({ lineNo, kind: "script", ref: m[1] });
  }
  if (cited) verifiedLines += 1;
});

// 3. Report.
if (dangling.length === 0) {
  console.log(`✓ CAPABILITIES.md: every cited test/script file exists (${verifiedLines} lines carry a file-level citation).`);
  process.exit(0);
}
console.error("✗ CAPABILITIES.md cites files that do not exist — the success metric is stale:\n");
for (const d of dangling) {
  console.error(`  line ${d.lineNo}: missing ${d.kind}  ${d.ref}`);
}
console.error(`\n${dangling.length} dangling citation(s). A cited proof that no longer exists makes the line a lie — restore the file or fix the citation.`);
process.exit(1);
