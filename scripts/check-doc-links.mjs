#!/usr/bin/env node
// Resolves every relative markdown link, #fragment and frontmatter `related:` entry
// across the repository's .md files.
//
// Code spans and fenced blocks are stripped BEFORE scanning: markdown does not turn
// `![](exfil)` inside backticks into a link, and a checker that flags it teaches
// people to ignore its output. Two such fixtures live in the injection-test notes.
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean);

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

const slug = (heading) =>
  heading.trim().replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");

const anchors = new Map();
for (const file of files) {
  const raw = readFileSync(join(ROOT, file), "utf8");
  const set = new Set();
  for (const m of raw.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) set.add(slug(m[1]));
  anchors.set(normalize(file), set);
}

const problems = [];
for (const file of files) {
  const raw = readFileSync(join(ROOT, file), "utf8");
  const dir = dirname(file);
  const body = stripCode(raw);

  for (const m of body.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const [target, fragment] = m[1].split("#");
    if (!target || /^(https?:|mailto:|#)/u.test(m[1])) continue;
    const resolved = normalize(join(dir, target));
    if (!existsSync(join(ROOT, resolved))) { problems.push(`${file}: missing target ${m[1]}`); continue; }
    if (fragment && target.endsWith(".md")) {
      const set = anchors.get(resolved);
      if (set && !set.has(fragment)) problems.push(`${file}: missing anchor ${m[1]}`);
    }
  }
  for (const m of body.matchAll(/\]\(#([^)\s]+)\)/gu)) {
    if (!anchors.get(normalize(file))?.has(m[1])) problems.push(`${file}: missing own anchor #${m[1]}`);
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("related:")) continue;
    for (const m of line.matchAll(/[\p{L}\p{N}_./-]+\.md/gu)) {
      if (!existsSync(join(ROOT, normalize(join(dir, m[0]))))) problems.push(`${file}: missing frontmatter related ${m[0]}`);
    }
  }
}

if (problems.length > 0) {
  process.stdout.write(`[check-doc-links] ${problems.length} unresolved reference(s):\n`);
  for (const p of problems) process.stdout.write(`  ${p}\n`);
  process.stdout.write(`\nEvery relative link, #fragment and frontmatter related: entry must resolve.\n`);
  process.exit(1);
}
process.stdout.write(`[check-doc-links] clean — ${files.length} markdown files, every reference resolves.\n`);
