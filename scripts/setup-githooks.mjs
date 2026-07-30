#!/usr/bin/env node
// Points this checkout's git at the VERSIONED hooks in scripts/githooks/
// (core.hooksPath) instead of the unversioned, per-clone .git/hooks/*.
// Run automatically by the root "postinstall" script; safe to re-run.
//
// core.hooksPath is a normal (non-worktree-scoped) config key, so writing it
// from ANY worktree lands in the shared git-common-dir config and applies to
// every worktree of this repo — each worktree then resolves the relative
// "scripts/githooks" path against its OWN top level, so every worktree needs
// its own checked-out copy of scripts/githooks (true for any worktree of a
// branch that has this commit).
//
// Silent no-op outside a git working tree (e.g. an npm-installed copy with
// no .git, or a CI checkout that only unpacked a tarball) — nothing to wire
// up and nothing to warn about.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const HOOKS_RELATIVE_PATH = "scripts/githooks";

export function isInsideGitWorkTree(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

export function getRepoRoot(cwd) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

export function getGitCommonDir(cwd) {
  const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
  return path.resolve(cwd, out);
}

export function getHooksPath(cwd) {
  try {
    return execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export function setHooksPath(cwd, value) {
  execFileSync("git", ["config", "core.hooksPath", value], { cwd, encoding: "utf8" });
}

export function findHookFiles(hooksDir) {
  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Documentation beside the hooks is not a hook. Marking README.md executable made
      // `pnpm install` dirty the worktree with a mode change on every run.
      else if (entry.isFile() && !entry.name.endsWith(".md")) results.push(full);
    }
  };
  walk(hooksDir);
  return results;
}

export function chmodExecutable(paths) {
  const changed = [];
  for (const filePath of paths) {
    const before = fs.statSync(filePath).mode & 0o777;
    if (before !== 0o755) changed.push(filePath);
    fs.chmodSync(filePath, 0o755);
  }
  return changed;
}

export function findLegacyHooks(commonDir) {
  const legacyDir = path.join(commonDir, "hooks");
  const known = ["pre-push", "commit-msg"];
  if (!fs.existsSync(legacyDir)) return [];
  return known
    .map((name) => path.join(legacyDir, name))
    .filter((filePath) => fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink());
}

export function setupGitHooks(cwd) {
  if (!isInsideGitWorkTree(cwd)) {
    return { skipped: true, reason: "not inside a git working tree" };
  }
  const repoRoot = getRepoRoot(cwd);
  const hooksDir = path.join(repoRoot, HOOKS_RELATIVE_PATH);
  if (!fs.existsSync(hooksDir)) {
    return { skipped: true, reason: `${HOOKS_RELATIVE_PATH} not found under ${repoRoot}` };
  }

  const previous = getHooksPath(cwd);
  setHooksPath(cwd, HOOKS_RELATIVE_PATH);
  const chmodded = chmodExecutable(findHookFiles(hooksDir));
  const legacy = findLegacyHooks(getGitCommonDir(cwd));

  return {
    skipped: false,
    previous,
    current: HOOKS_RELATIVE_PATH,
    chmodded,
    legacy,
    repoRoot
  };
}

function main() {
  const result = setupGitHooks(process.cwd());
  if (result.skipped) return;

  const fromLabel = result.previous ?? "(unset — .git/hooks/*)";
  console.log(`setup-githooks: core.hooksPath ${fromLabel} -> ${result.current}`);
  if (result.chmodded.length > 0) {
    console.log(`setup-githooks: chmod +x ${result.chmodded.map((p) => path.relative(result.repoRoot, p)).join(", ")}`);
  }
  if (result.legacy.length > 0) {
    console.log(
      `setup-githooks: superseded (left in place, no longer read): ${result.legacy.join(", ")}`
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
