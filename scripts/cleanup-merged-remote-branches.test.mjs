import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  cleanupMergedRemoteBranches,
  defaultBranchCleanupRunner,
  parseBranchCleanupArgs
} from "./cleanup-merged-remote-branches.mjs";

const MAIN_SHA = "1".repeat(40);
const TIP_SHA = "2".repeat(40);
const ORIGIN_URL = "https://github.com/wlsdks/muse-agent.git";
const REPOSITORY = "wlsdks/muse-agent";
const REPOSITORY_ARG = `github.com/${REPOSITORY}`;
const SAFE_PROTECTION = {
  allow_deletions: { enabled: false },
  allow_force_pushes: { enabled: false },
  enforce_admins: { enabled: true }
};

function fakeRunner(options = {}) {
  const branches = options.branches ?? ["fix/done"];
  const calls = [];
  const remoteCalls = new Map();
  const remoteTips = {
    ...(options.remoteTips ?? Object.fromEntries(branches.map((branch) => [branch, TIP_SHA])))
  };
  const currentRemoteTips = { ...remoteTips };
  const trackingTips = options.trackingTips ?? remoteTips;
  let pullRequestChecks = 0;
  let protectionChecks = 0;
  let worktreeChecks = 0;
  let pushed = false;
  const tags = { ...(options.tags ?? {}) };
  const result = (code = 0, stdout = "", stderr = "") => ({ code, stderr, stdout });
  return {
    calls,
    tags,
    run: async (call) => {
      const key = `${call.command} ${call.args.join(" ")}`;
      calls.push(key);
      if (key === "git remote get-url --all origin") {
        return result(0, `${(options.fetchUrls ?? [ORIGIN_URL]).join("\n")}\n`);
      }
      if (key === "git remote get-url --push --all origin") {
        return result(0, `${(options.pushUrls ?? [ORIGIN_URL]).join("\n")}\n`);
      }
      if (key === `git fetch --prune ${ORIGIN_URL} +refs/heads/*:refs/remotes/origin/*`) return result();
      if (key === "git rev-parse --verify refs/remotes/origin/main^{commit}") {
        return result(0, `${pushed ? (options.postMainTip ?? MAIN_SHA) : MAIN_SHA}\n`);
      }
      if (key === "git worktree list --porcelain") {
        const snapshot = options.worktreeSnapshots?.[worktreeChecks] ?? options.worktrees ?? "";
        worktreeChecks += 1;
        return result(0, snapshot);
      }
      if (call.command === "gh" && call.args[0] === "pr" && call.args[1] === "list") {
        const branch = call.args[call.args.indexOf("--head") + 1];
        const heads = options.openPullRequestSnapshots?.[pullRequestChecks]
          ?? options.openPullRequests
          ?? [];
        pullRequestChecks += 1;
        return options.ghFailure
          ? result(1, "", "gh unavailable")
          : result(0, `${JSON.stringify(heads
            .filter((headRefName) => headRefName === branch)
            .map((headRefName) => ({ headRefName })))}\n`);
      }
      if (call.command === "gh" && call.args[0] === "api") {
        const snapshot = options.protectionSnapshots
          ? options.protectionSnapshots[protectionChecks]
          : (Object.hasOwn(options, "protection") ? options.protection : SAFE_PROTECTION);
        protectionChecks += 1;
        return options.protectionFailure
          ? result(1, "", "Branch not protected")
          : result(0, `${JSON.stringify(snapshot)}\n`);
      }
      if (call.command === "git" && call.args[0] === "check-ref-format") {
        return options.invalidRefs?.includes(call.args[2])
          ? result(1, "", "invalid ref")
          : result();
      }
      if (call.command === "git" && call.args[0] === "rev-parse" && call.args[2]?.startsWith("refs/remotes/origin/")) {
        const branch = call.args[2].slice("refs/remotes/origin/".length, -"^{commit}".length);
        return result(0, `${trackingTips[branch]}\n`);
      }
      if (call.command === "git" && call.args[0] === "merge-base") {
        const isPostDeleteMainCheck = pushed && call.args[2] === MAIN_SHA;
        const code = isPostDeleteMainCheck
          ? (options.postMainMergeBaseCode ?? 0)
          : (options.mergeBaseCode ?? 0);
        return result(code, "", code && code !== 1 ? "graph failure" : "");
      }
      if (call.command === "git" && call.args[0] === "ls-remote") {
        const branch = call.args[3].slice("refs/heads/".length);
        if (pushed) {
          const remaining = options.remainingTips?.[branch];
          return remaining ? result(0, `${remaining}\trefs/heads/${branch}\n`) : result();
        }
        const count = remoteCalls.get(branch) ?? 0;
        remoteCalls.set(branch, count + 1);
        const tip = count === 0
          ? remoteTips[branch]
          : (options.finalTips?.[branch] ?? currentRemoteTips[branch]);
        currentRemoteTips[branch] = tip;
        return tip ? result(0, `${tip}\trefs/heads/${branch}\n`) : result();
      }
      if (call.command === "git" && call.args[0] === "push") {
        Object.assign(currentRemoteTips, options.pushTimeTips ?? {});
        const leases = call.args
          .filter((arg) => arg.startsWith("--force-with-lease="))
          .map((arg) => /^--force-with-lease=refs\/heads\/(.+):([0-9a-f]{40,64})$/u.exec(arg));
        const deletionRefspecs = new Set(call.args.filter((arg) => arg.startsWith(":refs/heads/")));
        if (call.args[1] !== "--atomic" || leases.length !== branches.length || leases.some((lease) => !lease)) {
          return result(1, "", "missing atomic compare-and-delete guard");
        }
        if (!call.args.includes(ORIGIN_URL)) return result(1, "", "wrong push URL");
        for (const lease of leases) {
          const [, branch, expectedTip] = lease;
          if (currentRemoteTips[branch] !== expectedTip) return result(1, "", "stale info");
          if (!deletionRefspecs.has(`:refs/heads/${branch}`)) return result(1, "", "missing deletion refspec");
        }
        if (options.pushFailure) return result(1, "", "remote rejected");
        pushed = true;
        return result();
      }
      throw new Error(`unexpected command: ${key}`);
    }
  };
}

test("argument parsing requires exact task branch names and an explicit delete flag", () => {
  assert.deepEqual(parseBranchCleanupArgs(["fix/done"]), { branches: ["fix/done"], shouldDelete: false });
  assert.deepEqual(parseBranchCleanupArgs(["--delete", "docs/done"]), { branches: ["docs/done"], shouldDelete: true });
  assert.throws(() => parseBranchCleanupArgs([]), /provide one or more/u);
  assert.throws(() => parseBranchCleanupArgs(["main"]), /refusing non-task branch/u);
  assert.throws(() => parseBranchCleanupArgs(["refs/heads/fix/done"]), /refusing non-task branch/u);
  assert.throws(() => parseBranchCleanupArgs(["fix/done", "fix/done"]), /duplicate/u);
  assert.throws(() => parseBranchCleanupArgs(["--remote=upstream", "fix/done"]), /unknown option/u);
});

test("a Git-invalid name that passes the task-name prefilter still fails closed", async () => {
  const branch = "fix/done..invalid";
  const fake = fakeRunner({ branches: [branch], invalidRefs: [branch] });
  await assert.rejects(
    cleanupMergedRemoteBranches({ branches: [branch], root: "/repo", run: fake.run }),
    /branch name 'fix\/done\.\.invalid' verification failed/u
  );
});

test("a missing command executable fails closed", () => {
  assert.throws(
    () => defaultBranchCleanupRunner({
      args: [],
      command: "muse-cleanup-command-that-does-not-exist",
      cwd: process.cwd()
    }),
    /ENOENT/u
  );
});

test("dry-run proves containment and produces no remote mutation", async () => {
  const fake = fakeRunner();
  const lines = [];
  const result = await cleanupMergedRemoteBranches({
    branches: ["fix/done"],
    root: "/repo",
    run: fake.run,
    stdout: (line) => lines.push(line)
  });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.eligible, [{ branch: "fix/done", remoteTip: TIP_SHA }]);
  assert.equal(fake.calls.some((entry) => entry.startsWith("git push ")), false);
  assert.match(lines.join(""), /dry-run only/u);
  assert.match(lines.join(""), /cleanup-merged-remote-branches\.mjs --delete fix\/done/u);
  assert.doesNotMatch(lines.join(""), /git push/u);
  assert.equal(
    fake.calls.filter((entry) => entry === (
      `gh pr list --repo ${REPOSITORY_ARG} --state open --head fix/done --json headRefName --limit 1`
    )).length,
    1
  );
});

test("origin and PR verification are bound to one configured GitHub repository", async (context) => {
  await context.test("different fetch and push URLs fail closed", async () => {
    const fake = fakeRunner({ pushUrls: ["git@github.com:wlsdks/other.git"] });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /origin fetch and push URLs differ/u
    );
    assert.equal(fake.calls.some((entry) => entry.startsWith("gh pr list ")), false);
  });
  await context.test("multiple origin URLs fail closed", async () => {
    const fake = fakeRunner({ fetchUrls: [ORIGIN_URL, "https://github.com/wlsdks/other.git"] });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /origin fetch URL did not resolve to one URL/u
    );
  });
  await context.test("network commands use immutable URLs and explicit GitHub host", async () => {
    const fake = fakeRunner();
    await cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run });
    assert.ok(fake.calls.includes(
      `git fetch --prune ${ORIGIN_URL} +refs/heads/*:refs/remotes/origin/*`
    ));
    assert.ok(fake.calls.includes(`git ls-remote --heads ${ORIGIN_URL} refs/heads/fix/done`));
    assert.ok(fake.calls.includes(
      `gh api --hostname github.com -H Accept: application/vnd.github+json -H X-GitHub-Api-Version: 2022-11-28 repos/${REPOSITORY}/branches/main/protection`
    ));
    assert.ok(fake.calls.includes(
      `gh pr list --repo ${REPOSITORY_ARG} --state open --head fix/done --json headRefName --limit 1`
    ));
    assert.equal(fake.calls.includes("git fetch origin --prune"), false);
    assert.equal(fake.calls.includes("git ls-remote --heads origin refs/heads/fix/done"), false);
  });
});

test("main protection is a fail-closed prerequisite", async (context) => {
  await context.test("missing protection", async () => {
    const fake = fakeRunner({ protectionFailure: true });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /main protection verification failed/u
    );
    assert.equal(fake.calls.some((entry) => entry.startsWith("git fetch ")), false);
  });
  await context.test("admin enforcement disabled", async () => {
    const fake = fakeRunner({ protection: { ...SAFE_PROTECTION, enforce_admins: { enabled: false } } });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /admin enforcement enabled/u
    );
  });
  await context.test("force pushes allowed", async () => {
    const fake = fakeRunner({ protection: { ...SAFE_PROTECTION, allow_force_pushes: { enabled: true } } });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /force pushes disabled/u
    );
  });
  await context.test("branch deletion allowed", async () => {
    const fake = fakeRunner({ protection: { ...SAFE_PROTECTION, allow_deletions: { enabled: true } } });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /branch deletion disabled/u
    );
  });
  await context.test("invalid protection response", async () => {
    const fake = fakeRunner({ protection: null });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /invalid shape/u
    );
  });
});

test("delete rechecks safety and uses an exact-tip lease before proving absence", async () => {
  const fake = fakeRunner({ tags: { "fix/done": "9".repeat(40) } });
  const result = await cleanupMergedRemoteBranches({
    branches: ["fix/done"],
    root: "/repo",
    run: fake.run,
    shouldDelete: true,
    stdout: () => undefined
  });
  assert.deepEqual(result.deleted, [{ branch: "fix/done", remoteTip: TIP_SHA }]);
  assert.equal(fake.calls.filter((entry) => entry === "git worktree list --porcelain").length, 2);
  assert.equal(fake.calls.filter((entry) => entry.startsWith("gh pr list ")).length, 2);
  assert.equal(fake.calls.filter((entry) => entry === (
    `git fetch --prune ${ORIGIN_URL} +refs/heads/*:refs/remotes/origin/*`
  )).length, 2);
  assert.equal(fake.calls.filter((entry) => entry.startsWith("gh api --hostname github.com ")).length, 3);
  assert.equal(
    fake.calls.filter((entry) => entry === (
      "git push --atomic "
      + `--force-with-lease=refs/heads/fix/done:${TIP_SHA} `
      + `${ORIGIN_URL} :refs/heads/fix/done`
    )).length,
    1
  );
  assert.deepEqual(fake.tags, { "fix/done": "9".repeat(40) });
});

test("all branches are verified before one atomic compare-and-delete push", async () => {
  const branches = ["docs/old", "fix/done"];
  const fake = fakeRunner({ branches });
  await cleanupMergedRemoteBranches({ branches, root: "/repo", run: fake.run, shouldDelete: true, stdout: () => undefined });
  assert.equal(
    fake.calls.filter((entry) => entry === (
      "git push --atomic "
      + `--force-with-lease=refs/heads/docs/old:${TIP_SHA} `
      + `--force-with-lease=refs/heads/fix/done:${TIP_SHA} `
      + `${ORIGIN_URL} :refs/heads/docs/old :refs/heads/fix/done`
    )).length,
    1
  );
  for (const branch of branches) {
    assert.equal(
      fake.calls.filter((entry) => entry === (
        `gh pr list --repo ${REPOSITORY_ARG} --state open --head ${branch} --json headRefName --limit 1`
      )).length,
      2
    );
  }
});

test("unmerged, active-worktree, and open-PR branches fail closed", async (context) => {
  await context.test("unmerged", async () => {
    const fake = fakeRunner({ mergeBaseCode: 1 });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /refusing unmerged branch/u
    );
  });
  await context.test("active worktree", async () => {
    const fake = fakeRunner({ worktrees: "worktree /repo/wt\nbranch refs/heads/fix/done\n" });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /refusing active worktree branch/u
    );
  });
  await context.test("open pull request", async () => {
    const fake = fakeRunner({ openPullRequests: ["fix/done"] });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /open pull request/u
    );
  });
});

test("missing PR verification and stale remote-tracking state fail closed", async (context) => {
  await context.test("GitHub verification unavailable", async () => {
    const fake = fakeRunner({ ghFailure: true });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /open pull request verification.*failed/u
    );
  });
  await context.test("remote-tracking mismatch", async () => {
    const fake = fakeRunner({ trackingTips: { "fix/done": "3".repeat(40) } });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run }),
      /changed or was not fetched exactly/u
    );
  });
});

test("a tip change after verification blocks deletion without pushing", async () => {
  const fake = fakeRunner({ finalTips: { "fix/done": "4".repeat(40) } });
  await assert.rejects(
    cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
    /refusing changed remote tip/u
  );
  assert.equal(fake.calls.some((entry) => entry.startsWith("git push ")), false);
});

test("a tip race after the final lookup is rejected by the server-side lease", async () => {
  const fake = fakeRunner({ pushTimeTips: { "fix/done": "5".repeat(40) } });
  await assert.rejects(
    cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
    /atomic compare-and-delete failed: stale info/u
  );
  assert.equal(fake.calls.filter((entry) => entry.startsWith("git push ")).length, 1);
});

test("protection is rechecked immediately before deletion", async () => {
  const unsafeProtection = { ...SAFE_PROTECTION, allow_force_pushes: { enabled: true } };
  const fake = fakeRunner({ protectionSnapshots: [SAFE_PROTECTION, unsafeProtection] });
  await assert.rejects(
    cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
    /force pushes disabled/u
  );
  assert.equal(fake.calls.filter((entry) => entry.startsWith("git push ")).length, 0);
});

test("lost protection after deletion is surfaced before reporting success", async () => {
  const unsafeProtection = { ...SAFE_PROTECTION, enforce_admins: { enabled: false } };
  const lines = [];
  const fake = fakeRunner({ protectionSnapshots: [SAFE_PROTECTION, SAFE_PROTECTION, unsafeProtection] });
  await assert.rejects(
    cleanupMergedRemoteBranches({
      branches: ["fix/done"],
      root: "/repo",
      run: fake.run,
      shouldDelete: true,
      stdout: (line) => lines.push(line)
    }),
    /admin enforcement enabled/u
  );
  assert.doesNotMatch(lines.join(""), /deleted fix\/done/u);
});

test("post-delete main must remain a monotonic descendant", async () => {
  const fake = fakeRunner({ postMainMergeBaseCode: 1, postMainTip: "6".repeat(40) });
  await assert.rejects(
    cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
    /post-delete origin\/main monotonicity verification failed/u
  );
});

test("a new open PR or worktree between verification and deletion blocks the push", async (context) => {
  await context.test("new pull request", async () => {
    const fake = fakeRunner({ openPullRequestSnapshots: [[], ["fix/done"]] });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
      /open pull request/u
    );
    assert.equal(fake.calls.some((entry) => entry.startsWith("git push ")), false);
  });
  await context.test("new worktree", async () => {
    const fake = fakeRunner({
      worktreeSnapshots: ["", "worktree /repo/wt\nbranch refs/heads/fix/done\n"]
    });
    await assert.rejects(
      cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
      /active worktree/u
    );
    assert.equal(fake.calls.some((entry) => entry.startsWith("git push ")), false);
  });
});

test("a branch that remains remotely after push is never reported deleted", async () => {
  const fake = fakeRunner({ remainingTips: { "fix/done": TIP_SHA } });
  await assert.rejects(
    cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
    /still exists after deletion/u
  );
});

test("remote rejection is reported and never bypassed", async () => {
  const fake = fakeRunner({ pushFailure: true });
  await assert.rejects(
    cleanupMergedRemoteBranches({ branches: ["fix/done"], root: "/repo", run: fake.run, shouldDelete: true }),
    /atomic compare-and-delete failed: remote rejected/u
  );
  assert.equal(fake.calls.filter((entry) => entry.startsWith("git push ")).length, 1);
});
