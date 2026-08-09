#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const COMMAND_TIMEOUT_MS = 2 * 60_000;
const TASK_BRANCH = /^(?:chore|docs|feat|fix|perf|refactor|test)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function call(command, args, cwd) {
  return { args, command, cwd };
}

export function defaultBranchCleanupRunner({ command, args, cwd }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? ""
  };
}

async function requireSuccessful(run, command, label) {
  const result = await run(command);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function requireCommitSha(value, label) {
  const sha = value.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) {
    throw new Error(`${label} did not resolve to one commit SHA`);
  }
  return sha;
}

function singleRemoteUrl(output, label) {
  const urls = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (urls.length !== 1) throw new Error(`${label} did not resolve to one URL`);
  return urls[0];
}

function githubRepositoryFrom(url) {
  const normalized = url.endsWith(".git") ? url.slice(0, -4) : url;
  const match = [
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u
  ].map((pattern) => pattern.exec(normalized)).find(Boolean);
  if (!match) throw new Error("origin is not one supported github.com repository URL");
  return `${match[1]}/${match[2]}`;
}

async function configuredOrigin(run, root) {
  const fetchUrlResult = await requireSuccessful(
    run,
    call("git", ["remote", "get-url", "--all", "origin"], root),
    "origin fetch URL verification"
  );
  const pushUrlResult = await requireSuccessful(
    run,
    call("git", ["remote", "get-url", "--push", "--all", "origin"], root),
    "origin push URL verification"
  );
  const fetchUrl = singleRemoteUrl(fetchUrlResult.stdout, "origin fetch URL");
  const pushUrl = singleRemoteUrl(pushUrlResult.stdout, "origin push URL");
  if (fetchUrl !== pushUrl) throw new Error("origin fetch and push URLs differ");
  return { fetchUrl, pushUrl, repository: githubRepositoryFrom(fetchUrl) };
}

function protectedBoolean(value, label, expected) {
  if (!value || typeof value !== "object" || value.enabled !== expected) {
    throw new Error(`main protection must keep ${label} ${expected ? "enabled" : "disabled"}`);
  }
}

async function requireProtectedMain(run, root, repository) {
  const result = await requireSuccessful(
    run,
    call(
      "gh",
      [
        "api", "--hostname", "github.com",
        "-H", "Accept: application/vnd.github+json",
        "-H", "X-GitHub-Api-Version: 2022-11-28",
        `repos/${repository}/branches/main/protection`
      ],
      root
    ),
    "main protection verification"
  );
  let protection;
  try {
    protection = JSON.parse(result.stdout);
  } catch {
    throw new Error("main protection verification returned invalid JSON");
  }
  if (!protection || typeof protection !== "object" || Array.isArray(protection)) {
    throw new Error("main protection verification returned an invalid shape");
  }
  protectedBoolean(protection.enforce_admins, "admin enforcement", true);
  protectedBoolean(protection.allow_force_pushes, "force pushes", false);
  protectedBoolean(protection.allow_deletions, "branch deletion", false);
}

function remoteTipFrom(output, branch, required = true) {
  const lines = output.trim() ? output.trim().split("\n") : [];
  if (lines.length === 0 && !required) return undefined;
  const match = lines.length === 1
    ? /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/u.exec(lines[0])
    : undefined;
  if (!match || match[2] !== branch) {
    throw new Error(`origin/${branch} did not resolve to one exact remote branch tip`);
  }
  return match[1];
}

function activeWorktreeBranches(output) {
  return new Set(output.split("\n")
    .filter((line) => line.startsWith("branch refs/heads/"))
    .map((line) => line.slice("branch refs/heads/".length)));
}

function openPullRequestHeadsFrom(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("open pull request verification returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry.headRefName !== "string")) {
    throw new Error("open pull request verification returned an invalid shape");
  }
  return new Set(parsed.map((entry) => entry.headRefName));
}

export function parseBranchCleanupArgs(args) {
  const shouldDelete = args.includes("--delete");
  const unknownOptions = args.filter((arg) => arg.startsWith("-") && arg !== "--delete");
  if (unknownOptions.length > 0) {
    throw new Error(`unknown option: ${unknownOptions[0]}`);
  }
  const branches = args.filter((arg) => arg !== "--delete");
  if (branches.length === 0) {
    throw new Error("provide one or more exact task branch names");
  }
  if (new Set(branches).size !== branches.length) {
    throw new Error("duplicate branch names are not allowed");
  }
  for (const branch of branches) {
    if (!TASK_BRANCH.test(branch)) {
      throw new Error(`refusing non-task branch '${branch}'`);
    }
  }
  return { branches, shouldDelete };
}

async function currentSafetyState(run, root, branches, repository) {
  const worktrees = await requireSuccessful(
    run,
    call("git", ["worktree", "list", "--porcelain"], root),
    "worktree verification"
  );
  const openPullRequestHeads = new Set();
  for (const branch of branches) {
    const pullRequests = await requireSuccessful(
      run,
      call(
        "gh",
        [
          "pr", "list", "--repo", `github.com/${repository}`, "--state", "open", "--head", branch,
          "--json", "headRefName", "--limit", "1"
        ],
        root
      ),
      `open pull request verification for '${branch}'`
    );
    const heads = openPullRequestHeadsFrom(pullRequests.stdout);
    if ([...heads].some((head) => head !== branch)) {
      throw new Error(`open pull request verification for '${branch}' returned an unexpected head`);
    }
    for (const head of heads) openPullRequestHeads.add(head);
  }
  return {
    activeBranches: activeWorktreeBranches(worktrees.stdout),
    openPullRequestHeads
  };
}

function assertInactive(branches, state) {
  for (const branch of branches) {
    if (state.activeBranches.has(branch)) {
      throw new Error(`refusing active worktree branch '${branch}'`);
    }
    if (state.openPullRequestHeads.has(branch)) {
      throw new Error(`refusing branch '${branch}' with an open pull request`);
    }
  }
}

async function exactRemoteTip(run, root, fetchUrl, branch, required = true) {
  const result = await requireSuccessful(
    run,
    call("git", ["ls-remote", "--heads", fetchUrl, `refs/heads/${branch}`], root),
    `origin/${branch} verification`
  );
  return remoteTipFrom(result.stdout, branch, required);
}

export async function cleanupMergedRemoteBranches(options) {
  const root = options.root ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const run = options.run ?? defaultBranchCleanupRunner;
  const stdout = options.stdout ?? ((line) => process.stdout.write(line));
  const branches = options.branches ?? [];
  const shouldDelete = options.shouldDelete ?? false;
  parseBranchCleanupArgs([...(shouldDelete ? ["--delete"] : []), ...branches]);

  const origin = await configuredOrigin(run, root);
  await requireProtectedMain(run, root, origin.repository);
  const fetchArgs = [
    "fetch", "--prune", origin.fetchUrl,
    "+refs/heads/*:refs/remotes/origin/*"
  ];
  await requireSuccessful(run, call("git", fetchArgs, root), "origin fetch");
  const main = await requireSuccessful(
    run,
    call("git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], root),
    "origin/main verification"
  );
  const mainSha = requireCommitSha(main.stdout, "origin/main");
  const initialState = await currentSafetyState(run, root, branches, origin.repository);
  assertInactive(branches, initialState);

  const verified = [];
  for (const branch of branches) {
    await requireSuccessful(
      run,
      call("git", ["check-ref-format", "--branch", branch], root),
      `branch name '${branch}' verification`
    );
    const remoteTip = await exactRemoteTip(run, root, origin.fetchUrl, branch);
    const tracking = await requireSuccessful(
      run,
      call("git", ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`], root),
      `origin/${branch} tracking verification`
    );
    const trackingTip = requireCommitSha(tracking.stdout, `origin/${branch}`);
    if (trackingTip !== remoteTip) {
      throw new Error(`origin/${branch} changed or was not fetched exactly`);
    }
    const merged = await run(call("git", ["merge-base", "--is-ancestor", remoteTip, mainSha], root));
    if (merged.code === 1) {
      throw new Error(`refusing unmerged branch '${branch}'`);
    }
    if (merged.code !== 0) {
      const detail = merged.stderr.trim() || merged.stdout.trim() || `exit ${String(merged.code)}`;
      throw new Error(`origin/${branch} containment verification failed: ${detail}`);
    }
    verified.push({ branch, remoteTip });
    stdout(`eligible ${branch} ${remoteTip}\n`);
  }

  if (!shouldDelete) {
    stdout(
      `dry-run only; re-run this verifier with: node scripts/cleanup-merged-remote-branches.mjs --delete ${branches.join(" ")}\n`
    );
    return { deleted: [], eligible: verified };
  }

  const finalState = await currentSafetyState(run, root, branches, origin.repository);
  assertInactive(branches, finalState);
  for (const candidate of verified) {
    const finalTip = await exactRemoteTip(run, root, origin.fetchUrl, candidate.branch);
    if (finalTip !== candidate.remoteTip) {
      throw new Error(`refusing changed remote tip for '${candidate.branch}'`);
    }
  }
  await requireProtectedMain(run, root, origin.repository);

  await requireSuccessful(
    run,
    call(
      "git",
      [
        "push",
        "--atomic",
        ...verified.map((candidate) => (
          `--force-with-lease=refs/heads/${candidate.branch}:${candidate.remoteTip}`
        )),
        origin.pushUrl,
        ...verified.map((candidate) => `:refs/heads/${candidate.branch}`)
      ],
      root
    ),
    "atomic compare-and-delete"
  );
  await requireProtectedMain(run, root, origin.repository);
  await requireSuccessful(run, call("git", fetchArgs, root), "post-delete origin fetch");
  const postMain = await requireSuccessful(
    run,
    call("git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], root),
    "post-delete origin/main verification"
  );
  const postMainSha = requireCommitSha(postMain.stdout, "post-delete origin/main");
  const monotonicMain = await run(call("git", ["merge-base", "--is-ancestor", mainSha, postMainSha], root));
  if (monotonicMain.code !== 0) {
    const detail = monotonicMain.stderr.trim() || monotonicMain.stdout.trim() || `exit ${String(monotonicMain.code)}`;
    throw new Error(`post-delete origin/main monotonicity verification failed: ${detail}`);
  }
  for (const candidate of verified) {
    const remaining = await exactRemoteTip(run, root, origin.fetchUrl, candidate.branch, false);
    if (remaining !== undefined) {
      throw new Error(`origin/${candidate.branch} still exists after deletion`);
    }
    stdout(`deleted ${candidate.branch} ${candidate.remoteTip}\n`);
  }
  return { deleted: verified, eligible: verified };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    const parsed = parseBranchCleanupArgs(process.argv.slice(2));
    await cleanupMergedRemoteBranches(parsed);
  } catch (error) {
    process.stderr.write(`Remote branch cleanup blocked: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
