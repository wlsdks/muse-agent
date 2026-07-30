#!/usr/bin/env node
/**
 * Comment-marker guard (.claude/rules/engineering/code-style.md): iteration/goal/round/
 * fire history markers are forbidden in source comments — history belongs in
 * git and CHANGELOG.md. This locks in the 2026-07 sweep so the class can't
 * silently regrow.
 *
 * Precision-first patterns (misses are acceptable; false positives are not):
 *   - "Goal 127", "goal 070"      — goal + number
 *   - "round 158"                 — round + 2+ digits (1-digit "round 1/2"
 *     is a legitimate debate/trim-sequence label in several tests)
 *   - "iter 26", "iter #47"       — iter + number
 *   - "fire 8", "fires 40-51"     — fire(s) + number (loop-fire markers)
 * Only comment lines (`//` and `*`) are scanned; strings/fixtures are not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages", "apps"];
const SUBDIRS = ["src", "test"];
const MARKERS = [
  /\/\/.*\b[Gg]oal \d+\b/,
  /^\s*\*.*\b[Gg]oal \d+\b/,
  /\/\/.*\b[Rr]ound \d{2,}\b/,
  /^\s*\*.*\b[Rr]ound \d{2,}\b/,
  /\/\/.*\b[Ii]ter\.? ?#?\d+\b/,
  /^\s*\*.*\b[Ii]ter\.? ?#?\d+\b/,
  // "fire(s) N" not followed by a prose word — "fires 2-3 embed calls" is the
  // verb, "(fire 26)" / "fires 19/21." is the loop-fire marker.
  // (the `[-/\d]` arm keeps backtracking from re-matching a shorter range)
  /\/\/.*\bfires? \d+(?:[-/]\d+)?(?![-/\d]|\s+[a-z])/,
  /^\s*\*.*\bfires? \d+(?:[-/]\d+)?(?![-/\d]|\s+[a-z])/
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(entry)) yield path;
  }
}

const hits = [];
for (const root of ROOTS) {
  let workspaces;
  try {
    workspaces = readdirSync(root);
  } catch {
    continue;
  }
  for (const workspace of workspaces) {
    for (const sub of SUBDIRS) {
      for (const file of walk(join(root, workspace, sub))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (MARKERS.some((re) => re.test(line))) {
            hits.push(`${file}:${(index + 1).toString()}  ${line.trim().slice(0, 120)}`);
          }
        });
      }
    }
  }
}

if (hits.length > 0) {
  console.error(`[check-comment-markers] ${hits.length.toString()} forbidden history marker(s) in source comments:`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error("History belongs in git/CHANGELOG.md, not source comments (.claude/rules/engineering/code-style.md).");
  process.exit(1);
}
console.log("[check-comment-markers] clean — no iteration/goal/round/fire markers in source comments.");
