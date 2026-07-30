#!/usr/bin/env node
// Two silent-failure classes around `.claude/agents/`:
//
// 1. A file's frontmatter `name:` is what the host resolves `subagent_type` against, NOT the
//    filename. If they drift, an invocation either fails or picks something else, and nothing
//    in a test suite notices.
// 2. A doc that says "use the X subagent" when no X exists sends the next agent at nothing.
//    Renaming independent-evaluator (formerly harness-evaluator) touched five files; a sixth
//    would have rotted silently.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const AGENT_DIR = join(ROOT, ".claude", "agents");

const NORMATIVE = (file) =>
  file.startsWith(".claude/") || ["CLAUDE.md", "AGENTS.md"].includes(file);

const problems = [];
const declared = new Set();

if (existsSync(AGENT_DIR)) {
  for (const entry of readdirSync(AGENT_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const expected = basename(entry, ".md");
    const declaredName = /^name:\s*(\S+)\s*$/mu.exec(readFileSync(join(AGENT_DIR, entry), "utf8"))?.[1];
    if (!declaredName) { problems.push(`.claude/agents/${entry}: no frontmatter name:`); continue; }
    declared.add(declaredName);
    if (declaredName !== expected) {
      problems.push(`.claude/agents/${entry}: frontmatter name \`${declaredName}\` does not match the filename`);
    }
  }
}

// Host-provided agents a doc may legitimately name without a file in this repo.
const HOST_PROVIDED = new Set(["general-purpose", "Explore", "Plan", "claude", "claude-code-guide", "statusline-setup"]);

for (const file of execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
  if (!NORMATIVE(file) || file.startsWith(".claude/agents/")) continue;
  readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/`?\b([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`?\s+subagent\b/gu)) {
      const named = match[1];
      if (declared.has(named) || HOST_PROVIDED.has(named)) continue;
      problems.push(`${file}:${index + 1}: names a \`${named}\` subagent with no such agent file`);
    }
  });
}

if (problems.length > 0) {
  process.stdout.write(`[check-agent-registry] ${problems.length} problem(s):\n`);
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.stdout.write(`\nAn agent file's frontmatter name must equal its filename, and a named subagent must exist.\n`);
  process.exit(1);
}
process.stdout.write(`[check-agent-registry] clean — ${declared.size} agent(s), every named subagent resolves.\n`);
