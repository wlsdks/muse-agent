/**
 * `muse update` — pull, install, and rebuild the latest Muse from the git
 * checkout the running CLI was launched from, or leave everything exactly as
 * it was. No git/pnpm knowledge required: a dirty tree, a non-main branch, a
 * failed pull, or a failed install/build all refuse/roll back instead of
 * leaving a half-updated install. `--check` reports how far behind
 * origin/main the checkout is without touching anything.
 *
 * Every git/pnpm invocation goes through the ONE injected `run` seam
 * (mirrors `DaemonHelpers.runLaunchctl` in commands-daemon-register.ts) so a
 * test can prove the exact command sequence without ever mutating this repo,
 * and `defaultUpdateRunner` hard-refuses to exec for real under vitest even
 * if a test forgets to inject.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Command } from "commander";

import { runCommandWithTimeout } from "@muse/shared";

import type { ProgramIO } from "./program.js";

const GIT_QUICK_TIMEOUT_MS = 30_000;
const GIT_PULL_TIMEOUT_MS = 120_000;
const PNPM_INSTALL_TIMEOUT_MS = 180_000;
const PNPM_BUILD_TIMEOUT_MS = 300_000;
const OVERALL_TIMEOUT_MS = 10 * 60_000;
const CHANGELOG_SUBJECT_LIMIT = 15;

export interface UpdateExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type UpdateRunner = (call: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}) => Promise<UpdateExecResult>;

function isRunningUnderVitest(): boolean {
  return (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
}

/**
 * Never reaches a real `git`/`pnpm` under vitest, even if a test forgets to
 * inject `UpdateCommandHelpers.run` — running this repo's own update flow for
 * real inside the suite would mutate the working tree the suite runs from.
 */
export const defaultUpdateRunner: UpdateRunner = async ({ command, args, cwd, timeoutMs }) => {
  if (isRunningUnderVitest()) {
    throw new Error(
      `refusing to exec real '${command} ${args.join(" ")}' under vitest — inject UpdateCommandHelpers.run in this test`
    );
  }
  return runCommandWithTimeout({ command, args, cwd, timeoutMs });
};

/**
 * Pure repo-root finder: walks parents of the running entry's realpath
 * looking for `pnpm-workspace.yaml`. No child process, so it's testable
 * directly against a temp-dir fixture.
 */
export function discoverRepoRoot(
  entry: string | undefined,
  exists: (path: string) => boolean = existsSync,
  resolveRealPath: (path: string) => string = realpathSync
): string | undefined {
  if (!entry || entry.trim().length === 0) return undefined;
  let real: string;
  try {
    real = resolveRealPath(entry);
  } catch {
    return undefined;
  }
  let dir = dirname(real);
  for (let i = 0; i < 32; i++) {
    if (exists(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function isGitRepo(repoRoot: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(repoRoot, ".git"));
}

function tail(text: string, lines = 20): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function splitLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** feat/fix commits surface first (still capped at `limit`); original relative order is kept within each group. */
export function selectChangelogSubjects(
  logLines: readonly string[],
  limit: number
): { readonly count: number; readonly subjects: readonly string[] } {
  const subjects = logLines.map((line) => line.replace(/^[0-9a-f]+\s+/u, ""));
  const priority = (subject: string): number => (/^(feat|fix)(\(|:)/u.test(subject) ? 0 : 1);
  const ordered = subjects
    .map((subject, index) => ({ index, rank: priority(subject), subject }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.subject);
  return { count: subjects.length, subjects: ordered.slice(0, limit) };
}

export function touchesDesktop(paths: readonly string[]): boolean {
  return paths.some((path) => path === "apps/desktop" || path.startsWith("apps/desktop/"));
}

export interface UpdateCommandDeps {
  readonly check: boolean;
  readonly entry: string | undefined;
  readonly run: UpdateRunner;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now?: () => number;
  readonly existsSync?: (path: string) => boolean;
  readonly realpathSync?: (path: string) => string;
}

export async function runUpdateCommand(deps: UpdateCommandDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const exists = deps.existsSync ?? existsSync;
  const resolveRealPath = deps.realpathSync ?? realpathSync;
  const { stdout, stderr, run, check } = deps;

  const repoRoot = discoverRepoRoot(deps.entry, exists, resolveRealPath);
  if (!repoRoot || !isGitRepo(repoRoot, exists)) {
    stderr(
      "muse update: this install can't self-update — it isn't running from a git checkout of the Muse workspace " +
      "(no pnpm-workspace.yaml + .git found above the running entry). Nothing was touched.\n"
    );
    return 1;
  }

  const deadline = now() + OVERALL_TIMEOUT_MS;
  const budget = (max: number): number => Math.max(0, Math.min(max, deadline - now()));
  const git = (args: readonly string[], timeoutMs: number) => run({ args, command: "git", cwd: repoRoot, timeoutMs });
  const pnpmRun = (args: readonly string[], timeoutMs: number) => run({ args, command: "pnpm", cwd: repoRoot, timeoutMs });

  if (check) {
    stdout("Checking for updates…\n");
    const fetchResult = await git(["fetch"], budget(GIT_PULL_TIMEOUT_MS));
    if (fetchResult.exitCode !== 0 || fetchResult.timedOut) {
      stderr(`muse update --check: git fetch failed — ${(fetchResult.stderr || fetchResult.stdout || "unknown error").trim()}\n`);
      return 1;
    }
    const aheadResult = await git(["rev-list", "--count", "HEAD..origin/main"], budget(GIT_QUICK_TIMEOUT_MS));
    if (aheadResult.exitCode !== 0) {
      stderr(`muse update --check: could not compute the ahead-count — ${(aheadResult.stderr || "unknown error").trim()}\n`);
      return 1;
    }
    const ahead = Number.parseInt(aheadResult.stdout.trim(), 10) || 0;
    stdout(ahead <= 0
      ? "Muse is up to date.\n"
      : `${String(ahead)} commit(s) behind origin/main — run \`muse update\` to update.\n`);
    return 0;
  }

  stdout("Checking working tree…\n");
  const statusResult = await git(["status", "--porcelain"], budget(GIT_QUICK_TIMEOUT_MS));
  if (statusResult.exitCode !== 0) {
    stderr(`muse update: git status failed — ${(statusResult.stderr || "unknown error").trim()}\n`);
    return 1;
  }
  if (statusResult.stdout.trim().length > 0) {
    stderr("muse update: local changes present — commit or discard first. Nothing was touched.\n");
    return 1;
  }

  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"], budget(GIT_QUICK_TIMEOUT_MS));
  const branch = branchResult.stdout.trim();
  if (branchResult.exitCode !== 0 || branch !== "main") {
    stderr(
      `muse update: refusing to update — this checkout is on ${branch === "HEAD" || !branch ? "a detached HEAD" : `branch '${branch}'`}, ` +
      "not 'main'. Switch to main first. Nothing was touched.\n"
    );
    return 1;
  }

  const oldHeadResult = await git(["rev-parse", "HEAD"], budget(GIT_QUICK_TIMEOUT_MS));
  const oldHead = oldHeadResult.stdout.trim();
  if (oldHeadResult.exitCode !== 0 || !oldHead) {
    stderr("muse update: could not resolve the current commit. Nothing was touched.\n");
    return 1;
  }

  if (budget(1) <= 0) {
    stderr("muse update: exceeded the 10-minute update budget before pulling. Nothing was touched.\n");
    return 1;
  }

  stdout("Pulling latest…\n");
  const pullResult = await git(["pull", "--ff-only"], budget(GIT_PULL_TIMEOUT_MS));
  if (pullResult.exitCode !== 0 || pullResult.timedOut) {
    stderr(`muse update: git pull --ff-only failed — ${(pullResult.stderr || pullResult.stdout || "unknown error").trim()}\nNothing was changed.\n`);
    return 1;
  }

  const newHeadResult = await git(["rev-parse", "HEAD"], budget(GIT_QUICK_TIMEOUT_MS));
  const newHead = newHeadResult.stdout.trim();
  if (newHeadResult.exitCode !== 0 || !newHead) {
    stderr("muse update: could not resolve the updated commit. Nothing further was changed.\n");
    return 1;
  }

  if (newHead === oldHead) {
    stdout("Already up to date.\n");
    return 0;
  }

  const rollback = async (reason: string): Promise<number> => {
    stderr(`muse update: ${reason}\n`);
    stdout("Rolling back to the previous version…\n");
    const resetResult = await git(["reset", "--hard", oldHead], budget(GIT_QUICK_TIMEOUT_MS));
    if (resetResult.exitCode !== 0) {
      stderr(
        `muse update: automatic rollback FAILED (git reset --hard ${oldHead} exited ${String(resetResult.exitCode)}). ` +
        `Manual recovery: cd ${repoRoot} && git reset --hard ${oldHead} && pnpm build\n`
      );
      return 1;
    }
    const rebuildResult = await pnpmRun(["build"], budget(PNPM_BUILD_TIMEOUT_MS));
    if (rebuildResult.exitCode !== 0) {
      stderr(
        "muse update: rolled back the code but the rebuild ALSO failed. " +
        `Manual recovery: cd ${repoRoot} && pnpm build\n${tail(rebuildResult.stderr || rebuildResult.stdout)}\n`
      );
      return 1;
    }
    stderr("muse update failed, restored previous version.\n");
    return 1;
  };

  const lockDiffResult = await git(
    ["diff", "--name-only", `${oldHead}..${newHead}`, "--", "pnpm-lock.yaml"],
    budget(GIT_QUICK_TIMEOUT_MS)
  );
  if (lockDiffResult.stdout.trim().length > 0) {
    if (budget(1) <= 0) return rollback("exceeded the 10-minute update budget before installing dependencies");
    stdout("Lockfile changed — installing dependencies…\n");
    const installResult = await pnpmRun(["install", "--frozen-lockfile"], budget(PNPM_INSTALL_TIMEOUT_MS));
    if (installResult.exitCode !== 0 || installResult.timedOut) {
      return rollback(`pnpm install --frozen-lockfile failed — ${tail(installResult.stderr || installResult.stdout)}`);
    }
  }

  if (budget(1) <= 0) return rollback("exceeded the 10-minute update budget before building");
  stdout("Building…\n");
  const buildResult = await pnpmRun(["build"], budget(PNPM_BUILD_TIMEOUT_MS));
  if (buildResult.exitCode !== 0 || buildResult.timedOut) {
    return rollback(`pnpm build failed — ${tail(buildResult.stderr || buildResult.stdout)}`);
  }

  const logResult = await git(["log", "--oneline", `${oldHead}..${newHead}`], budget(GIT_QUICK_TIMEOUT_MS));
  const { count, subjects } = selectChangelogSubjects(splitLines(logResult.stdout), CHANGELOG_SUBJECT_LIMIT);
  stdout(`\n${String(count)} commit(s):\n`);
  for (const subject of subjects) stdout(`  ${subject}\n`);

  const diffPathsResult = await git(["diff", "--name-only", `${oldHead}..${newHead}`], budget(GIT_QUICK_TIMEOUT_MS));
  if (exists(join(repoRoot, "apps", "desktop")) && touchesDesktop(splitLines(diffPathsResult.stdout))) {
    stdout("apps/desktop changed — rebuild the .app with `pnpm --filter @muse/desktop build` (or your usual desktop build step) to pick it up.\n");
  }

  stdout(`✓ Muse updated: ${shortSha(oldHead)} → ${shortSha(newHead)}\n`);
  return 0;
}

export interface UpdateCommandHelpers {
  readonly run?: UpdateRunner;
  readonly entry?: string;
  readonly now?: () => number;
  readonly existsSync?: (path: string) => boolean;
  readonly realpathSync?: (path: string) => string;
}

export function registerUpdateCommand(program: Command, io: ProgramIO, helpers: UpdateCommandHelpers = {}): void {
  program
    .command("update")
    .description("Pull, install, and rebuild the latest Muse from your git checkout — safely, or not at all")
    .option("--check", "Report how many commits behind origin/main you are, without changing anything")
    .action(async (options: { readonly check?: boolean }) => {
      const exitCode = await runUpdateCommand({
        check: Boolean(options.check),
        entry: helpers.entry ?? process.argv[1],
        run: helpers.run ?? defaultUpdateRunner,
        stdout: io.stdout,
        stderr: io.stderr,
        ...(helpers.now ? { now: helpers.now } : {}),
        ...(helpers.existsSync ? { existsSync: helpers.existsSync } : {}),
        ...(helpers.realpathSync ? { realpathSync: helpers.realpathSync } : {})
      });
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}
