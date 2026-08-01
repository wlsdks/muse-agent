#!/usr/bin/env node
/**
 * `pnpm test:changed` — run ONLY the tests related to what you actually changed,
 * not a whole package suite (18.4k passing cases across 1624 executed files is too heavy per edit).
 *
 * For each git-changed `.ts/.tsx` file, vitest's `related` resolves the tests whose
 * Vite module graph touches it (a changed test file runs directly). One `vitest
 * related` invocation per affected package. Browser suites are excluded from the
 * normal fork pool and, when a package has a browser config, run separately in
 * real Browser Mode. Playwright `e2e/` specs are likewise kept out of Vitest
 * and run through the owning package's Playwright config. Zero changed files ⇒ exit 0 (nothing to
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
export const ATTUNEGRAPH_SUBMODULE_PATH = "packages/attunegraph";
export const ATTUNEGRAPH_SUBMODULE_GATE_PACKAGES = [
  "@attunegraph/core",
  "@muse/attunegraph",
  "@muse/cli"
];

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function hasAttuneGraphGitlinkChange(rawDiff) {
  return rawDiff.split("\n").some((line) => {
    const [metadata, ...paths] = line.split("\t");
    if (!metadata?.split(" ").includes("160000")) return false;
    return paths.includes(ATTUNEGRAPH_SUBMODULE_PATH);
  });
}

export function isVitestBrowserConfig(file) {
  return file === "vitest.browser.config.ts";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Union of staged + unstaged + UNTRACKED (a brand-new file — e.g. a freshly added
  // `*.test.ts` — is NOT in `git diff`, so without ls-files it would be silently
  // skipped) (+ committed-since-main, unless --uncommitted).
  const sources = [
  ["diff", "--name-only"],
  ["diff", "--name-only", "--cached"],
  ["ls-files", "--others", "--exclude-standard"],
  ...(uncommittedOnly ? [] : [["diff", "--name-only", "origin/main...HEAD"]])
  ];
  const rawSources = [
  ["diff", "--raw"],
  ["diff", "--raw", "--cached"],
  ...(uncommittedOnly ? [] : [["diff", "--raw", "origin/main...HEAD"]])
  ];
  const attuneGraphGitlinkChanged = rawSources.some((args) => hasAttuneGraphGitlinkChange(git(args)));
  const changed = new Set();
  for (const args of sources) {
  for (const line of git(args).split("\n")) {
    const f = line.trim();
    if (
      f
      && /\.(ts|tsx)$/.test(f)
      && (f.startsWith("packages/") || f.startsWith("apps/"))
      && !(attuneGraphGitlinkChanged && f.startsWith(`${ATTUNEGRAPH_SUBMODULE_PATH}/`))
    ) changed.add(f);
  }
  }

  if (changed.size === 0 && !attuneGraphGitlinkChanged) {
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
  if (!byPackage.has(pkg.name)) byPackage.set(pkg.name, { dir: pkg.dir, files: [] });
  byPackage.get(pkg.name).files.push(pkg.rel);
  }

  if (orphans.length > 0) {
  console.log(`[test:changed] ${orphans.length.toString()} changed file(s) outside a workspace package — skipped: ${orphans.join(", ")}`);
  }
  if (byPackage.size === 0 && !attuneGraphGitlinkChanged) {
  console.log("[test:changed] no changed files map to a workspace package — nothing to test.");
  process.exit(0);
  }

  console.log(`[test:changed] ${changed.size.toString()} changed file(s) across ${byPackage.size.toString()} package(s); running each package's RELATED tests only:`);
  let failed = false;
  if (attuneGraphGitlinkChanged) {
  console.log("[test:changed] AttuneGraph gitlink changed; running conservative core, Muse integration, and CLI package gates.");
  for (const name of ATTUNEGRAPH_SUBMODULE_GATE_PACKAGES) {
    try {
      execFileSync("pnpm", ["--filter", name, "test"], { cwd: ROOT, stdio: "inherit" });
    } catch {
      failed = true;
    }
  }
  }
  for (const [name, entry] of byPackage) {
  const { dir, files } = entry;
  const browserConfig = join(dir, "vitest.browser.config.ts");
  const hasBrowserConfig = existsSync(browserConfig);
  const playwrightFiles = files.filter((file) => file.split("/").includes("e2e"));
  const personalAgentPlaywrightFiles = playwrightFiles.filter((file) =>
    file.startsWith("e2e/personal-agent/")
  );
  const standardPlaywrightFiles = playwrightFiles.filter((file) =>
    !personalAgentPlaywrightFiles.includes(file)
  );
  const browserConfigFiles = files.filter(isVitestBrowserConfig);
  const vitestFiles = files.filter(
    (file) => !playwrightFiles.includes(file) && !browserConfigFiles.includes(file)
  );
  if (vitestFiles.length > 0) {
    console.log(`\n── ${name} ── vitest related ${vitestFiles.join(" ")}`);
    try {
      execFileSync(
        "pnpm",
        ["--filter", name, "exec", "vitest", "related", ...vitestFiles, "--run", ...(hasBrowserConfig ? ["--exclude", "**/*.browser.test.tsx"] : [])],
        { cwd: ROOT, stdio: "inherit" }
      );
    } catch {
      failed = true; // a non-zero exit (a failing/erroring test) — surface it, keep going across packages
    }
  }
  if (hasBrowserConfig && (vitestFiles.length > 0 || browserConfigFiles.length > 0)) {
    console.log(`\n── ${name} browser ── vitest Browser Mode related`);
    try {
      const args = browserConfigFiles.length > 0
        ? ["--filter", name, "test:browser"]
        : ["--filter", name, "exec", "vitest", "related", ...vitestFiles, "--run", "--config", "vitest.browser.config.ts"];
      execFileSync("pnpm", args, { cwd: ROOT, stdio: "inherit" });
    } catch {
      failed = true;
    }
  }
  if (standardPlaywrightFiles.length > 0) {
    console.log(`\n── ${name} e2e ── Playwright ${standardPlaywrightFiles.join(" ")}`);
    try {
      execFileSync(
        "pnpm",
        ["--filter", name, "exec", "playwright", "test", ...standardPlaywrightFiles],
        { cwd: ROOT, stdio: "inherit" }
      );
    } catch {
      failed = true;
    }
  }
  if (personalAgentPlaywrightFiles.length > 0) {
    console.log(`\n── ${name} personal-agent e2e ── owned fixture ${personalAgentPlaywrightFiles.join(" ")}`);
    try {
      execFileSync("pnpm", ["test:e2e:personal-agent"], { cwd: ROOT, stdio: "inherit" });
    } catch {
      failed = true;
    }
  }
  }
  process.exit(failed ? 1 : 0);
}
