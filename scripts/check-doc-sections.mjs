#!/usr/bin/env node
// A `§N` reference must point at a section that exists with that number.
//
// The rot this closes: renumbering a document silently redirects every deep link into it.
// Renumbering `dev-loop.md` sent both improve-muse and grow-muse from "THE LOOP" to
// "Anti-patterns" — the link still resolved, the target file still existed, and
// check-doc-links reported clean, because only the MEANING moved.
//
// Deliberately narrow, and these bounds are measured, not assumed:
//  - CROSS-FILE only. A self-reference ("see §4" inside the same document) is not checked,
//    because a bare §N routinely refers to a document named on an earlier line — probing
//    found handoff.md's "§1.6" means contract.md's, so a naive self-check false-positives
//    on a legitimate and common pattern.
//  - The mark must sit next to its target, so a link and a §N split across two lines is
//    missed. Nobody gains by splitting a line, so this is coverage, not a bypass.
//  - A prose promise ("see X for the onboarding checklist") is semantic and stays a
//    review concern.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const NORMATIVE = (file) =>
  file.startsWith(".claude/") || file.startsWith("docs/") ||
  ["CLAUDE.md", "AGENTS.md", "README.md", "CONTRIBUTING.md", "CONTEXT.md"].includes(file);

// Section numbers a document actually declares, e.g. "## 3.6 When the evaluator…" -> "3.6".
const sectionsOf = new Map();
const sectionNumbers = (absolute) => {
  if (sectionsOf.has(absolute)) return sectionsOf.get(absolute);
  const found = new Set();
  if (existsSync(absolute)) {
    for (const m of readFileSync(absolute, "utf8").matchAll(/^#{1,6}\s+§?(\d+(?:\.\d+)?)[.)]?\s/gmu)) {
      found.add(m[1]);
    }
  }
  sectionsOf.set(absolute, found);
  return found;
};

const problems = [];
for (const file of execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
  if (!NORMATIVE(file)) continue;
  const dir = dirname(file);
  readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, index) => {
    // Only the three shapes this repo actually writes, each with the section mark
    // ADJACENT to the thing it qualifies. A looser same-line association mis-read
    // "(contract §6). History: [CHANGELOG.md](CHANGELOG.md)" as a claim about the changelog.
    const refs = [
      ...line.matchAll(/\]\(([\w./-]+\.md)\)\s*§\s?(\d+(?:\.\d+)*)/gu),          // [x](t.md) §N
      ...line.matchAll(/§\s?(\d+(?:\.\d+)*)\]\(([\w./-]+\.md)\)/gu),              // [x §N](t.md)
      ...line.matchAll(/`([\w./-]+\.md)`\s*§\s?(\d+(?:\.\d+)*)/gu),                 // `t.md` §N
    ];
    for (const match of refs) {
      // the two capture groups arrive in either order depending on the shape
      const [target, mark] = match[1].endsWith(".md") ? [match[1], match[2]] : [match[2], match[1]];
      const resolved = existsSync(join(ROOT, dir, target)) ? join(ROOT, dir, target)
        : existsSync(join(ROOT, target)) ? join(ROOT, target) : null;
      if (!resolved) continue;  // a missing target is check-doc-links' job, not this one
      if (normalize(resolved) === normalize(join(ROOT, file))) continue;
      const declared = sectionNumbers(resolved);
      if (declared.size === 0) continue;  // the target does not number its sections
      if (declared.has(mark)) continue;
      problems.push(`${file}:${index + 1}: ${target} has no §${mark} (it has ${[...declared].join(", ")})`);
    }
  });
}

if (problems.length > 0) {
  process.stdout.write(`[check-doc-sections] ${problems.length} section reference(s) that do not resolve:\n`);
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.stdout.write(`\nRenumbering a document silently redirects every deep link into it.\n`);
  process.exit(1);
}
process.stdout.write(`[check-doc-sections] clean — every §N reference points at a section that exists.\n`);
