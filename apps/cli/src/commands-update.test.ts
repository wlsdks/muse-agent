import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultUpdateRunner,
  discoverRepoRoot,
  isGitRepo,
  runUpdateCommand,
  selectChangelogSubjects,
  touchesDesktop,
  type UpdateCommandDeps,
  type UpdateExecResult,
  type UpdateRunner
} from "./commands-update.js";

const dirsToClean: string[] = [];

function makeFixtureRepo(opts: { readonly withGit?: boolean; readonly withDesktop?: boolean } = {}): { readonly root: string; readonly entry: string } {
  // macOS mkdtemp lands under /tmp, a symlink to /private/tmp — realpath it
  // up front so the returned root matches what discoverRepoRoot (which
  // realpaths the entry) resolves to.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muse-update-repo-")));
  dirsToClean.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  if (opts.withGit !== false) mkdirSync(join(root, ".git"));
  if (opts.withDesktop) mkdirSync(join(root, "apps", "desktop"), { recursive: true });
  const entryDir = join(root, "apps", "cli", "dist");
  mkdirSync(entryDir, { recursive: true });
  const entry = join(entryDir, "index.js");
  writeFileSync(entry, "// fixture entry\n");
  return { entry, root };
}

afterEach(() => {
  while (dirsToClean.length > 0) {
    const dir = dirsToClean.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

describe("discoverRepoRoot", () => {
  it("walks up from a real temp-dir fixture to find pnpm-workspace.yaml", () => {
    const { entry, root } = makeFixtureRepo();
    expect(discoverRepoRoot(entry)).toBe(root);
  });

  it("returns undefined when no pnpm-workspace.yaml exists above the entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-update-no-workspace-"));
    dirsToClean.push(dir);
    const entry = join(dir, "index.js");
    writeFileSync(entry, "// fixture\n");
    expect(discoverRepoRoot(entry)).toBeUndefined();
  });

  it("returns undefined for an empty/undefined entry", () => {
    expect(discoverRepoRoot(undefined)).toBeUndefined();
    expect(discoverRepoRoot("")).toBeUndefined();
  });
});

describe("isGitRepo", () => {
  it("true when .git exists under the root", () => {
    const { root } = makeFixtureRepo();
    expect(isGitRepo(root)).toBe(true);
  });

  it("false when .git is missing", () => {
    const { root } = makeFixtureRepo({ withGit: false });
    expect(isGitRepo(root)).toBe(false);
  });
});

describe("selectChangelogSubjects", () => {
  it("orders feat/fix commits first, capped at the limit, preserving relative order within each group", () => {
    const lines = [
      "aaa0001 chore: tidy",
      "aaa0002 feat: add widget",
      "aaa0003 docs: update readme",
      "aaa0004 fix: crash on null"
    ];
    const { count, subjects } = selectChangelogSubjects(lines, 15);
    expect(count).toBe(4);
    expect(subjects).toEqual(["feat: add widget", "fix: crash on null", "chore: tidy", "docs: update readme"]);
  });

  it("caps subjects at the limit but keeps the full count", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `sha${String(i)} chore: item ${String(i)}`);
    const { count, subjects } = selectChangelogSubjects(lines, 15);
    expect(count).toBe(20);
    expect(subjects).toHaveLength(15);
  });
});

describe("touchesDesktop", () => {
  it("true for a path under apps/desktop/", () => {
    expect(touchesDesktop(["apps/cli/src/x.ts", "apps/desktop/src/main.ts"])).toBe(true);
  });

  it("false when no path is under apps/desktop", () => {
    expect(touchesDesktop(["apps/cli/src/x.ts", "packages/shared/src/y.ts"])).toBe(false);
  });
});

describe("defaultUpdateRunner", () => {
  it("refuses to exec for real under vitest (hard boundary)", async () => {
    await expect(defaultUpdateRunner({ args: ["status"], command: "git", cwd: "/tmp", timeoutMs: 1000 })).rejects.toThrow(
      /refusing to exec real/u
    );
  });
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
}

function makeRun(script: (call: Call) => UpdateExecResult): { readonly run: UpdateRunner; readonly calls: Call[] } {
  const calls: Call[] = [];
  const run: UpdateRunner = async (call) => {
    calls.push({ args: call.args, command: call.command });
    return script(call);
  };
  return { calls, run };
}

const ok = (stdout = ""): UpdateExecResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });
const fail = (stderr = "boom", exitCode = 1): UpdateExecResult => ({ exitCode, stderr, stdout: "", timedOut: false });

function baseDeps(run: UpdateRunner, entry: string, overrides: Partial<UpdateCommandDeps> = {}): UpdateCommandDeps {
  return {
    check: false,
    entry,
    run,
    stderr: () => undefined,
    stdout: () => undefined,
    ...overrides
  };
}

describe("runUpdateCommand — not a repo", () => {
  it("refuses and executes nothing when no pnpm-workspace.yaml is found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-update-not-repo-"));
    dirsToClean.push(dir);
    const entry = join(dir, "index.js");
    writeFileSync(entry, "// fixture\n");
    const { calls, run } = makeRun(() => ok());
    const messages: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { stderr: (m) => messages.push(m) }));
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(messages.join("")).toMatch(/can't self-update/u);
  });

  it("refuses when the workspace root has no .git", async () => {
    const { entry } = makeFixtureRepo({ withGit: false });
    const { calls, run } = makeRun(() => ok());
    const exitCode = await runUpdateCommand(baseDeps(run, entry));
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("runUpdateCommand — preflight refusals", () => {
  it("dirty tree refuses BEFORE any state-changing command", async () => {
    const { entry } = makeFixtureRepo();
    const { calls, run } = makeRun((call) => {
      if (call.args[0] === "status") return ok(" M some-file.ts\n");
      throw new Error(`unexpected call: ${call.command} ${call.args.join(" ")}`);
    });
    const messages: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { stderr: (m) => messages.push(m) }));
    expect(exitCode).toBe(1);
    expect(calls).toEqual([{ args: ["status", "--porcelain"], command: "git" }]);
    expect(messages.join("")).toMatch(/local changes present/u);
  });

  it("detached HEAD / non-main branch refuses before pulling", async () => {
    const { entry } = makeFixtureRepo();
    const { calls, run } = makeRun((call) => {
      if (call.args[0] === "status") return ok("");
      if (call.args.join(" ") === "rev-parse --abbrev-ref HEAD") return ok("feature-branch\n");
      throw new Error(`unexpected call: ${call.command} ${call.args.join(" ")}`);
    });
    const messages: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { stderr: (m) => messages.push(m) }));
    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(2);
    expect(messages.join("")).toMatch(/not 'main'/u);
  });
});

describe("runUpdateCommand — pull failure", () => {
  it("stops after a failed pull; no install/build attempted", async () => {
    const { entry } = makeFixtureRepo();
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "status --porcelain") return ok("");
      if (key === "rev-parse --abbrev-ref HEAD") return ok("main\n");
      if (key === "rev-parse HEAD") return ok("abc1234deadbeef\n");
      if (key === "pull --ff-only") return fail("network unreachable");
      throw new Error(`unexpected call: ${call.command} ${key}`);
    });
    const exitCode = await runUpdateCommand(baseDeps(run, entry));
    expect(exitCode).toBe(1);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "status --porcelain",
      "rev-parse --abbrev-ref HEAD",
      "rev-parse HEAD",
      "pull --ff-only"
    ]);
    expect(calls.some((c) => c.command === "pnpm")).toBe(false);
  });
});

describe("runUpdateCommand — already up to date", () => {
  it("exits 0 with no install/build when HEAD didn't move", async () => {
    const { entry } = makeFixtureRepo();
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "status --porcelain") return ok("");
      if (key === "rev-parse --abbrev-ref HEAD") return ok("main\n");
      if (key === "rev-parse HEAD") return ok("abc1234\n");
      if (key === "pull --ff-only") return ok("Already up to date.\n");
      throw new Error(`unexpected call: ${key}`);
    });
    const messages: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { stdout: (m) => messages.push(m) }));
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.command === "pnpm")).toBe(false);
    expect(messages.join("")).toMatch(/up to date/iu);
  });
});

describe("runUpdateCommand — build failure triggers rollback", () => {
  it("resets to oldHead and rebuilds, reports failure, exit non-zero", async () => {
    const { entry } = makeFixtureRepo();
    let revParseCalls = 0;
    let pnpmBuildCalls = 0;
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "status --porcelain") return ok("");
      if (key === "rev-parse --abbrev-ref HEAD") return ok("main\n");
      if (key === "rev-parse HEAD") {
        revParseCalls += 1;
        return ok(revParseCalls === 1 ? "old1234\n" : "new5678\n");
      }
      if (key === "pull --ff-only") return ok("Updating...\n");
      if (key.startsWith("diff --name-only old1234..new5678 -- pnpm-lock.yaml")) return ok("");
      if (key === "build" && call.command === "pnpm") {
        pnpmBuildCalls += 1;
        // First build (the real update) fails; rollback's rebuild succeeds.
        return pnpmBuildCalls === 1 ? fail("tsc error TS2322") : ok("");
      }
      if (key === "reset --hard old1234") return ok("");
      throw new Error(`unexpected call: ${call.command} ${key}`);
    });
    const stderrMsgs: string[] = [];
    const stdoutMsgs: string[] = [];
    const exitCode = await runUpdateCommand(
      baseDeps(run, entry, { stderr: (m) => stderrMsgs.push(m), stdout: (m) => stdoutMsgs.push(m) })
    );
    expect(exitCode).toBe(1);
    expect(stderrMsgs.join("")).toMatch(/restored previous version/u);
    expect(stdoutMsgs.join("")).toMatch(/Rolling back/u);
    const sequence = calls.map((c) => `${c.command}:${c.args.join(" ")}`);
    expect(sequence).toEqual([
      "git:status --porcelain",
      "git:rev-parse --abbrev-ref HEAD",
      "git:rev-parse HEAD",
      "git:pull --ff-only",
      "git:rev-parse HEAD",
      "git:diff --name-only old1234..new5678 -- pnpm-lock.yaml",
      "pnpm:build",
      "git:reset --hard old1234",
      "pnpm:build"
    ]);
  });

  it("prints manual recovery instructions when the rollback rebuild ALSO fails", async () => {
    const { entry } = makeFixtureRepo();
    let revParseCalls = 0;
    let pnpmBuildCalls = 0;
    const { run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "status --porcelain") return ok("");
      if (key === "rev-parse --abbrev-ref HEAD") return ok("main\n");
      if (key === "rev-parse HEAD") {
        revParseCalls += 1;
        return ok(revParseCalls === 1 ? "old1234\n" : "new5678\n");
      }
      if (key === "pull --ff-only") return ok("Updating...\n");
      if (key.startsWith("diff --name-only")) return ok("");
      if (key === "build") {
        pnpmBuildCalls += 1;
        return fail(`build failed attempt ${String(pnpmBuildCalls)}`);
      }
      if (key === "reset --hard old1234") return ok("");
      throw new Error(`unexpected call: ${key}`);
    });
    const stderrMsgs: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { stderr: (m) => stderrMsgs.push(m) }));
    expect(exitCode).toBe(1);
    expect(stderrMsgs.join("")).toMatch(/Manual recovery:/u);
    expect(stderrMsgs.join("")).toMatch(/rebuild ALSO failed/u);
  });
});

describe("runUpdateCommand — success path", () => {
  it("runs commands in the exact safe order and renders the changelog", async () => {
    const { entry } = makeFixtureRepo({ withDesktop: true });
    let revParseCalls = 0;
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "status --porcelain") return ok("");
      if (key === "rev-parse --abbrev-ref HEAD") return ok("main\n");
      if (key === "rev-parse HEAD") {
        revParseCalls += 1;
        return ok(revParseCalls === 1 ? "old1234\n" : "new5678\n");
      }
      if (key === "pull --ff-only") return ok("Updating...\n");
      if (key.startsWith("diff --name-only old1234..new5678 -- pnpm-lock.yaml")) return ok("pnpm-lock.yaml\n");
      if (key === "install --frozen-lockfile") return ok("");
      if (key === "build") return ok("");
      if (key === "log --oneline old1234..new5678") {
        return ok("new5678 feat: widget\nold9999 chore: tidy\n");
      }
      if (key === "diff --name-only old1234..new5678") return ok("apps/desktop/src/main.ts\n");
      throw new Error(`unexpected call: ${call.command} ${key}`);
    });
    const stdoutMsgs: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { stdout: (m) => stdoutMsgs.push(m) }));
    expect(exitCode).toBe(0);
    const sequence = calls.map((c) => `${c.command}:${c.args.join(" ")}`);
    expect(sequence).toEqual([
      "git:status --porcelain",
      "git:rev-parse --abbrev-ref HEAD",
      "git:rev-parse HEAD",
      "git:pull --ff-only",
      "git:rev-parse HEAD",
      "git:diff --name-only old1234..new5678 -- pnpm-lock.yaml",
      "pnpm:install --frozen-lockfile",
      "pnpm:build",
      "git:log --oneline old1234..new5678",
      "git:diff --name-only old1234..new5678"
    ]);
    const out = stdoutMsgs.join("");
    expect(out).toMatch(/2 commit\(s\):/u);
    expect(out).toMatch(/feat: widget/u);
    expect(out).toMatch(/rebuild the \.app/u);
    expect(out).toMatch(/✓ Muse updated: old1234 → new5678/u);
  });

  it("skips pnpm install when the lockfile did not change", async () => {
    const { entry } = makeFixtureRepo();
    let revParseCalls = 0;
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "status --porcelain") return ok("");
      if (key === "rev-parse --abbrev-ref HEAD") return ok("main\n");
      if (key === "rev-parse HEAD") {
        revParseCalls += 1;
        return ok(revParseCalls === 1 ? "old1234\n" : "new5678\n");
      }
      if (key === "pull --ff-only") return ok("Updating...\n");
      if (key.startsWith("diff --name-only old1234..new5678 -- pnpm-lock.yaml")) return ok("");
      if (key === "build") return ok("");
      if (key === "log --oneline old1234..new5678") return ok("new5678 chore: bump\n");
      if (key === "diff --name-only old1234..new5678") return ok("apps/cli/src/x.ts\n");
      throw new Error(`unexpected call: ${call.command} ${key}`);
    });
    const exitCode = await runUpdateCommand(baseDeps(run, entry));
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.args.join(" ") === "install --frozen-lockfile")).toBe(false);
  });
});

describe("runUpdateCommand — --check", () => {
  it("fetches + reports the ahead-count only; changes nothing", async () => {
    const { entry } = makeFixtureRepo();
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "fetch") return ok("");
      if (key === "rev-list --count HEAD..origin/main") return ok("3\n");
      throw new Error(`unexpected call: ${call.command} ${key}`);
    });
    const stdoutMsgs: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { check: true, stdout: (m) => stdoutMsgs.push(m) }));
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { args: ["fetch"], command: "git" },
      { args: ["rev-list", "--count", "HEAD..origin/main"], command: "git" }
    ]);
    expect(stdoutMsgs.join("")).toMatch(/3 commit\(s\) behind origin\/main/u);
  });
});

describe("runUpdateCommand — overall timeout budget", () => {
  it("aborts with rollback when the budget is exhausted before building", async () => {
    const { entry } = makeFixtureRepo();
    let revParseCalls = 0;
    const { calls, run } = makeRun((call) => {
      const key = call.args.join(" ");
      if (key === "status --porcelain") return ok("");
      if (key === "rev-parse --abbrev-ref HEAD") return ok("main\n");
      if (key === "rev-parse HEAD") {
        revParseCalls += 1;
        return ok(revParseCalls === 1 ? "old1234\n" : "new5678\n");
      }
      if (key === "pull --ff-only") return ok("Updating...\n");
      if (key.startsWith("diff --name-only old1234..new5678 -- pnpm-lock.yaml")) return ok("");
      if (key === "reset --hard old1234") return ok("");
      if (key === "build") return ok("");
      throw new Error(`unexpected call: ${call.command} ${key}`);
    });
    // now() stays well inside the 10-minute budget for the first 8 calls
    // (deadline calc + the 7 budget() checks up through the lockfile diff),
    // then jumps past the deadline on the 9th call — the explicit
    // pre-build budget check — so the abort fires exactly there.
    let callIndex = 0;
    const now = () => {
      callIndex += 1;
      return callIndex <= 8 ? callIndex * 1000 : 700_000;
    };
    const stderrMsgs: string[] = [];
    const exitCode = await runUpdateCommand(baseDeps(run, entry, { now, stderr: (m) => stderrMsgs.push(m) }));
    expect(exitCode).toBe(1);
    expect(stderrMsgs.join("")).toMatch(/exceeded the 10-minute update budget/u);
    expect(calls.some((c) => c.args.join(" ") === "reset --hard old1234")).toBe(true);
  });
});
