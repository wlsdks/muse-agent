#!/usr/bin/env node
/**
 * `pnpm test:changed` — run ONLY the tests related to what you actually changed,
 * not a whole package suite (12.8k cases across 1194 files is too heavy per edit).
 *
 * For each git-changed `.ts/.tsx` file, vitest's `related` resolves the tests whose
 * Vite module graph touches it (a changed test file runs directly). One `vitest
 * related` invocation per affected package. Zero changed files ⇒ exit 0 (nothing to
 * prove). This OPERATIONALIZES the "run the narrowest test that proves THIS change"
 * rule (testing.md) — the per-edit gate; `pnpm check` stays the pre-merge gate.
 *
 * Usage:
 *   pnpm test:changed            # uncommitted (staged+unstaged) AND committed-since-origin/main
 *   pnpm test:changed --uncommitted   # uncommitted only (the tight inner-loop default mid-edit)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = process.cwd();
const uncommittedOnly = process.argv.includes("--uncommitted");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// Union of staged + unstaged + UNTRACKED (a brand-new file — e.g. a freshly added
// `*.test.ts` — is NOT in `git diff`, so without ls-files it would be silently
// skipped) (+ committed-since-main, unless --uncommitted).
const sources = [
  ["diff", "--name-only"],
  ["diff", "--name-only", "--cached"],
  ["ls-files", "--others", "--exclude-standard"],
  ...(uncommittedOnly ? [] : [["diff", "--name-only", "origin/main...HEAD"]])
];
const changed = new Set();
for (const args of sources) {
  for (const line of git(args).split("\n")) {
    const f = line.trim();
    if (f && /\.(ts|tsx)$/.test(f) && (f.startsWith("packages/") || f.startsWith("apps/"))) changed.add(f);
  }
}

if (changed.size === 0) {
  console.log("[test:changed] no changed .ts files — nothing to test (clean tree vs origin/main).");
  process.exit(0);
}

// Map each file to its nearest package.json (the owning workspace) + a package-relative path.
function nearestPackage(file) {
  let dir = dirname(join(ROOT, file));
  while (dir.startsWith(ROOT)) {
    const pkgJson = join(dir, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const name = JSON.parse(readFileSync(pkgJson, "utf8")).name;
        if (name) return { dir, name, rel: relative(dir, join(ROOT, file)) };
      } catch { /* malformed package.json — keep walking up */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const byPackage = new Map();
const orphans = [];
for (const file of changed) {
  const pkg = nearestPackage(file);
  if (!pkg) { orphans.push(file); continue; }
  if (!byPackage.has(pkg.name)) byPackage.set(pkg.name, []);
  byPackage.get(pkg.name).push(pkg.rel);
}

if (orphans.length > 0) {
  console.log(`[test:changed] ${orphans.length.toString()} changed file(s) outside a workspace package — skipped: ${orphans.join(", ")}`);
}
if (byPackage.size === 0) {
  console.log("[test:changed] no changed files map to a workspace package — nothing to test.");
  process.exit(0);
}

console.log(`[test:changed] ${changed.size.toString()} changed file(s) across ${byPackage.size.toString()} package(s); running each package's RELATED tests only:`);
let failed = false;
for (const [name, files] of byPackage) {
  console.log(`\n── ${name} ── vitest related ${files.join(" ")}`);
  try {
    execFileSync(
      "pnpm",
      ["--filter", name, "exec", "vitest", "related", ...files, "--run"],
      { cwd: ROOT, stdio: "inherit" }
    );
  } catch {
    failed = true; // a non-zero exit (a failing/erroring test) — surface it, keep going across packages
  }
}
process.exit(failed ? 1 : 0);
