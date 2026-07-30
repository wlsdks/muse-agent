#!/usr/bin/env node
// Every `pnpm <script>` a doc tells an agent to run must exist.
//
// Docs are the operating instructions here, and a command that no longer exists costs
// an agent a failed run plus a re-derivation. Four separate audit passes in two weeks
// each found this class by hand; `eval:tools:nl` sat in a rules-file gate table with no
// such script in package.json.
//
// Scoped to normative docs. internal/goals/ and CHANGELOG.md are historical records —
// they name commands as they stood at the time, and that is correct, not drift.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

const NORMATIVE = (file) =>
  file.startsWith(".claude/") || file.startsWith("docs/") ||
  ["CLAUDE.md", "AGENTS.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CONTEXT.md"].includes(file);

// pnpm's own verbs. `pnpm test` and `pnpm lint` are scripts here, so they are NOT listed.
const PNPM_VERBS = new Set([
  "install", "i", "add", "remove", "rm", "update", "up", "outdated", "why", "list", "ls",
  "dlx", "exec", "create", "init", "link", "unlink", "publish", "pack", "store", "audit",
  "prune", "rebuild", "setup", "env", "config", "licenses", "patch", "patch-commit", "deploy",
]);

const scriptsOf = (dir) => {
  const file = join(ROOT, dir, "package.json");
  if (!existsSync(file)) return null;
  return new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")).scripts ?? {}));
};

const rootScripts = scriptsOf(".");
const workspaceDirs = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*/package.json", "*/*/package.json"],
  { cwd: ROOT, encoding: "utf8" }
).split("\n")
  .filter((file) => file.length > 0 && existsSync(join(ROOT, file)))
  .map((path) => path.replace(/\/package\.json$/u, ""));
const byPackageName = new Map();
for (const dir of workspaceDirs) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  if (manifest.name) byPackageName.set(manifest.name, new Set(Object.keys(manifest.scripts ?? {})));
}

// A placeholder is documentation, not a claim: `pnpm --filter @muse/<name> build`.
const isPlaceholder = (token) => /[<>{}*$]|\.\.\./u.test(token);

// Only a command the doc formatted AS a command is a claim. Prose that says "the pnpm
// workspace" or "pnpm 10" is talking about the tool, not telling anyone to run something —
// scanning raw lines produced twelve false positives against one real find.
const commandCandidates = (raw) => {
  const found = [];
  let fenced = false;
  raw.split("\n").forEach((line, index) => {
    if (/^\s*```/u.test(line)) { fenced = !fenced; return; }
    const pieces = fenced ? [line] : [...line.matchAll(/`([^`\n]*)`/gu)].map((m) => m[1]);
    for (const piece of pieces) found.push({ line: index + 1, text: piece });
  });
  return found;
};

const problems = [];
const markdownFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
  { cwd: ROOT, encoding: "utf8" }
).split("\n").filter((file) => file.length > 0 && existsSync(join(ROOT, file)));
for (const file of markdownFiles) {
  if (!NORMATIVE(file)) continue;
  commandCandidates(readFileSync(join(ROOT, file), "utf8")).forEach(({ line, text }) => {
    for (const match of text.matchAll(/\bpnpm(?=\s)([^|;&\n]*)/gu)) {
      const words = match[1].trim().split(/\s+/u).filter(Boolean);
      let target = null;
      let scripts = rootScripts;
      for (let i = 0; i < words.length; i += 1) {
        const word = words[i];
        if (word === "--filter" || word === "-F") {
          const named = words[i + 1];
          if (!named || isPlaceholder(named)) return;
          scripts = byPackageName.get(named) ?? null;
          if (!scripts) { problems.push(`${file}:${line}: unknown workspace ${named}`); return; }
          i += 1;
          continue;
        }
        if (word === "run" || word.startsWith("-")) continue;
        target = word;
        break;
      }
      // A script name, not a stray prose word: lowercase start, then word/:/-/. only.
      if (!target || isPlaceholder(target) || PNPM_VERBS.has(target)) continue;
      if (!/^[a-z][\w:.-]*$/u.test(target)) continue;
      if (!scripts.has(target)) problems.push(`${file}:${line}: no such script \`pnpm ${target}\``);
    }
  });
}

if (problems.length > 0) {
  process.stdout.write(`[check-doc-claims] ${problems.length} command claim(s) that do not resolve:\n`);
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.stdout.write(`\nEvery \`pnpm <script>\` a normative doc names must exist in the matching package.json.\n`);
  process.exit(1);
}
process.stdout.write(`[check-doc-claims] clean — every documented pnpm command resolves.\n`);
