#!/usr/bin/env node
// The four role subagents exist twice on purpose: `.claude/agents/harness-*.md` are the
// live definitions this repo invokes, and `harness/templates/claude-code/agents/` are the
// vendor-neutral copies INSTALL.md tells another project to take. Only ONE difference is
// legitimate — the live files name "the Muse agent harness", the templates say "the agent
// harness". Anything else means a rule landed in one copy and not the other, which is how
// the live evaluator silently lost its context-isolation rule.
import { readFileSync, existsSync } from "node:fs";

const ROLES = ["harness-worker", "harness-evaluator", "harness-planner", "harness-curator"];
const problems = [];

const body = (text) => {
  const parts = text.split("---");
  return (parts.length > 2 ? parts.slice(2).join("---") : text).replace(/\bMuse agent harness\b/g, "agent harness");
};

for (const role of ROLES) {
  const live = `.claude/agents/${role}.md`;
  const template = `harness/templates/claude-code/agents/${role}.md`;
  if (!existsSync(live)) { problems.push(`${live} is missing`); continue; }
  if (!existsSync(template)) { problems.push(`${template} is missing`); continue; }
  const a = body(readFileSync(live, "utf8")).trim();
  const b = body(readFileSync(template, "utf8")).trim();
  if (a !== b) problems.push(`${role}: the live definition and the export template have diverged beyond the Muse/neutral wording — port the rule into both`);
}

if (problems.length > 0) {
  process.stdout.write(`[check-harness-agents] ${problems.length} problem(s):\n`);
  for (const p of problems) process.stdout.write(`  ${p}\n`);
  process.exit(1);
}
process.stdout.write(`[check-harness-agents] clean — ${ROLES.length} role definitions match their export templates.\n`);
