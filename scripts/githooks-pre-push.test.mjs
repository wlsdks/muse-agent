import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const prePushScript = path.join(here, "githooks", "pre-push");
const realGitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const realGitDir = path.dirname(realGitPath);

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-test-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Muse Test"], { cwd: dir });
  return dir;
}

function makePnpmShim(logFile, exitCode = 0) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-pnpm-"));
  fs.writeFileSync(
    path.join(shimDir, "pnpm"),
    `#!/usr/bin/env bash\necho "$@" >> "${logFile}"\nexit ${exitCode}\n`,
    { mode: 0o755 }
  );
  return shimDir;
}

function makeDiffFailingGitShim() {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-git-"));
  fs.writeFileSync(
    path.join(shimDir, "git"),
    `#!/usr/bin/env bash\nif [ "$1" = "diff" ]; then exit 9; fi\nexec "${realGitPath}" "$@"\n`,
    { mode: 0o755 }
  );
  return shimDir;
}

function runHook(repoDir, { pathDirs, env = {}, input } = { pathDirs: [] }) {
  return spawnSync("bash", [prePushScript], {
    cwd: repoDir,
    env: {
      PATH: pathDirs.join(":"),
      HOME: env.HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-home-")),
      MUSE_PREPUSH_LOCK_TIMEOUT: "2",
      ...env
    },
    input,
    encoding: "utf8"
  });
}

function writeAndCommit(repoDir, relPath, contents, message) {
  const full = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  execFileSync("git", ["add", "--", relPath], { cwd: repoDir });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: repoDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

function removeAndCommit(repoDir, relPath, message) {
  execFileSync("git", ["rm", "--quiet", "--", relPath], { cwd: repoDir });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: repoDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

function refUpdateStdin(localSha, remoteSha, localRef = "refs/heads/main", remoteRef = "refs/heads/main") {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;
}

function calls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  const value = fs.readFileSync(logFile, "utf8").trim();
  return value ? value.split("\n") : [];
}


function installDocLinkChecker(repoDir) {
  const src = path.join(here, "check-doc-links.mjs");
  const dest = path.join(repoDir, "scripts", "check-doc-links.mjs");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  execFileSync("git", ["add", "--", "scripts/check-doc-links.mjs"], { cwd: repoDir });
  execFileSync("git", ["commit", "--quiet", "-m", "checker"], { cwd: repoDir });
}

test("missing pnpm blocks an unscoped/full deterministic gate", () => {
  const repoDir = makeTempRepo();
  const result = runHook(repoDir, { pathDirs: [realGitDir, "/usr/bin", "/bin"] });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BLOCKED.*pnpm not found/su);
});

test("docs-only push skips deterministic gates before pnpm resolution", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "docs/notes.md", "docs only\n", "docs");
  const result = runHook(repoDir, {
    pathDirs: [realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /deterministic gates skipped \(docs\/assets-only push\)/u);
  assert.doesNotMatch(result.stderr, /pnpm not found/u);
});

test("manual/no-ref invocation falls back to root typecheck, web typecheck, and full lint", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    env: { MUSE_SKIP_PREPUSH: "1" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile).map((call) =>
    call.includes("typecheck:fast") ? "root" : call.includes("@muse/web") ? "web" : call.includes("-s lint") ? "lint" : call
  ), ["root", "web", "lint"]);
});

test("non-web code runs root typecheck and changed-file lint only", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "packages/db/src/example.ts", "export const value = 1;\n", "db");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  const logged = calls(logFile);
  assert.equal(logged.length, 2);
  assert.match(logged[0], /typecheck:fast/u);
  assert.match(logged[1], /exec eslint.* -- packages\/db\/src\/example\.ts/u);
  assert.doesNotMatch(logged.join("\n"), /@muse\/web|precheck:grounding/u);
});

test("web code runs root typecheck, web typecheck, and changed-file lint", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "apps/web/src/example.ts", "export const value = 1;\n", "web");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  const logged = calls(logFile);
  assert.equal(logged.length, 3);
  assert.match(logged[0], /typecheck:fast/u);
  assert.match(logged[1], /--filter @muse\/web typecheck/u);
  assert.match(logged[2], /-- apps\/web\/src\/example\.ts/u);
});

test("shared-package code is treated as web-impacting", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "packages/shared/src/browser.ts", "export const shared = 1;\n", "shared");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(logFile).some((call) => call.includes("--filter @muse/web typecheck")));
});

test("package description-only change runs root typecheck without web or full lint", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(
    repoDir,
    "package.json",
    `${JSON.stringify({ description: "old identity", name: "muse" }, null, 2)}\n`,
    "base"
  );
  const localSha = writeAndCommit(
    repoDir,
    "package.json",
    `${JSON.stringify({ description: "new identity", name: "muse" }, null, 2)}\n`,
    "description"
  );
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile).map((call) => call.includes("typecheck:fast") ? "root" : call), ["root"]);
  assert.match(result.stderr, /apps\/web typecheck skipped/u);
  assert.match(result.stderr, /lint skipped/u);
});

test("non-description package change retains web typecheck and full lint", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(
    repoDir,
    "package.json",
    `${JSON.stringify({ description: "identity", name: "muse", scripts: { check: "old" } }, null, 2)}\n`,
    "base"
  );
  const localSha = writeAndCommit(
    repoDir,
    "package.json",
    `${JSON.stringify({ description: "identity", name: "muse", scripts: { check: "new" } }, null, 2)}\n`,
    "script"
  );
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile).map((call) =>
    call.includes("typecheck:fast") ? "root" : call.includes("@muse/web") ? "web" : call.includes("-s lint") ? "lint" : call
  ), ["root", "web", "lint"]);
});

test("same-line package keys cannot hide a non-description change", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(
    repoDir,
    "package.json",
    "{\n  \"description\": \"old identity\", \"name\": \"muse\"\n}\n",
    "base"
  );
  const localSha = writeAndCommit(
    repoDir,
    "package.json",
    "{\n  \"description\": \"new identity\", \"name\": \"renamed\"\n}\n",
    "mixed metadata"
  );
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile).map((call) =>
    call.includes("typecheck:fast") ? "root" : call.includes("@muse/web") ? "web" : call.includes("-s lint") ? "lint" : call
  ), ["root", "web", "lint"]);
});

test("changed-file lint preserves whitespace and option-like basenames behind --", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const file = "packages/db/src/-odd name.ts";
  const localSha = writeAndCommit(repoDir, file, "export const odd = true;\n", "odd");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(calls(logFile)[1], / -- packages\/db\/src\/-odd name\.ts$/u);
});

test("delete-only code diff typechecks but does not pass a missing file to ESLint", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "packages/db/src/deleted.ts", "export const gone = true;\n", "base");
  const localSha = removeAndCommit(repoDir, "packages/db/src/deleted.ts", "delete");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile).map((call) => call.includes("typecheck:fast") ? "root" : call), ["root"]);
  assert.match(result.stderr, /lint skipped/u);
});

test("an unclassified path falls back to root, web, and full lint", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "config/policy.weird", "strict\n", "unknown");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile).map((call) =>
    call.includes("typecheck:fast") ? "root" : call.includes("@muse/web") ? "web" : call.includes("-s lint") ? "lint" : call
  ), ["root", "web", "lint"]);
});

test("multi-ref input unions scope and deduplicates paths", () => {
  const repoDir = makeTempRepo();
  const base = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const webSha = writeAndCommit(repoDir, "apps/web/src/union.ts", "export const web = 1;\n", "web");
  execFileSync("git", ["checkout", "--quiet", "-b", "other", base], { cwd: repoDir });
  const otherSha = writeAndCommit(repoDir, "packages/db/src/union.ts", "export const db = 1;\n", "db");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const input = refUpdateStdin(webSha, base, "refs/heads/main", "refs/heads/main")
    + refUpdateStdin(otherSha, base, "refs/heads/other", "refs/heads/other");
  const result = runHook(repoDir, { pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"], input });

  assert.equal(result.status, 0, result.stderr);
  const logged = calls(logFile);
  assert.match(logged[0], /typecheck:fast/u);
  assert.match(logged[1], /@muse\/web/u);
  assert.equal(logged.filter((call) => call.includes("packages/db/src/union.ts")).length, 1);
});

test("the same path contributed by multiple refs appears once in the lint argv", () => {
  const repoDir = makeTempRepo();
  const base = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "packages/db/src/repeated.ts", "export const repeated = 1;\n", "repeat");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const input = refUpdateStdin(localSha, base, "refs/heads/main", "refs/heads/main")
    + refUpdateStdin(localSha, base, "refs/heads/other", "refs/heads/other");
  const result = runHook(repoDir, { pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"], input });

  assert.equal(result.status, 0, result.stderr);
  const lintCall = calls(logFile).find((call) => call.includes("exec eslint"));
  assert.equal(lintCall.split("packages/db/src/repeated.ts").length - 1, 1);
});

test("a new ref diffs its commit against the empty tree", () => {
  const repoDir = makeTempRepo();
  writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "apps/web/src/new-ref.ts", "export const added = 1;\n", "new ref");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, "0".repeat(40), "refs/heads/new", "refs/heads/new")
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(logFile).some((call) => call.includes("--filter @muse/web typecheck")));
  assert.ok(calls(logFile).some((call) => call.includes("apps/web/src/new-ref.ts")));
});

test("a ref deletion carries no tree content and skips deterministic gates", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "packages/db/src/deleted-ref.ts", "export const old = 1;\n", "remote");
  const result = runHook(repoDir, {
    pathDirs: [realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin("0".repeat(40), remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /deterministic gates skipped/u);
  assert.doesNotMatch(result.stderr, /pnpm not found/u);
});

test("force-update endpoints still classify their union", () => {
  const repoDir = makeTempRepo();
  const base = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const remoteSha = writeAndCommit(repoDir, "packages/db/src/remote.ts", "export const remote = 1;\n", "remote");
  execFileSync("git", ["checkout", "--quiet", "-b", "replacement", base], { cwd: repoDir });
  const localSha = writeAndCommit(repoDir, "packages/db/src/local.ts", "export const local = 1;\n", "local");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(calls(logFile)[0], /typecheck:fast/u);
  assert.match(calls(logFile)[1], /packages\/db\/src\/local\.ts/u);
});

test("malformed ref input fails closed to the full deterministic gate", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: "refs/heads/main not-a-sha refs/heads/main also-bad\n"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile).map((call) =>
    call.includes("typecheck:fast") ? "root" : call.includes("@muse/web") ? "web" : call.includes("-s lint") ? "lint" : call
  ), ["root", "web", "lint"]);
});

test("unknown Git objects fail closed to the full deterministic gate", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const fake = "1".repeat(40);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(fake, "0".repeat(40))
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(calls(logFile)[2], /-s lint/u);
});

test("git diff failure fails closed to the full deterministic gate", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "docs/notes.md", "would otherwise skip\n", "docs");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const gitDir = makeDiffFailingGitShim();
  const result = runHook(repoDir, {
    pathDirs: [gitDir, pnpmDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(calls(logFile)[2], /-s lint/u);
});

test("grounding requires both a relevant path and explicit opt-in", () => {
  const repoDir = makeTempRepo();
  const base = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "packages/agent-core/src/relevant.ts", "export const x = 1;\n", "agent");
  const input = refUpdateStdin(localSha, base);

  const defaultLog = path.join(repoDir, "default.log");
  const defaultPnpm = makePnpmShim(defaultLog);
  const defaultResult = runHook(repoDir, { pathDirs: [defaultPnpm, realGitDir, "/usr/bin", "/bin"], input });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.ok(!calls(defaultLog).some((call) => call.includes("precheck:grounding")));

  const optLog = path.join(repoDir, "opt.log");
  const optPnpm = makePnpmShim(optLog);
  const optResult = runHook(repoDir, {
    pathDirs: [optPnpm, realGitDir, "/usr/bin", "/bin"],
    env: { MUSE_RUN_PREPUSH_GROUNDING: "1" },
    input
  });
  assert.equal(optResult.status, 0, optResult.stderr);
  assert.ok(calls(optLog).some((call) => call.includes("precheck:grounding")));
});

test("MUSE_SKIP_PREPUSH wins over grounding opt-in without skipping deterministic gates", () => {
  const repoDir = makeTempRepo();
  const base = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "packages/agent-core/src/relevant.ts", "export const x = 1;\n", "agent");
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    env: { MUSE_RUN_PREPUSH_GROUNDING: "1", MUSE_SKIP_PREPUSH: "1" },
    input: refUpdateStdin(localSha, base)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls(logFile).some((call) => call.includes("typecheck:fast")));
  assert.ok(!calls(logFile).some((call) => call.includes("precheck:grounding")));
});

test("a failing root typecheck blocks before web, lint, or grounding", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile, 1);
  const result = runHook(repoDir, { pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"] });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BLOCKED.*typecheck:fast/su);
  assert.equal(calls(logFile).length, 1);
});

test("MUSE_SKIP_PREPUSH_ALL skips every stage", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const pnpmDir = makePnpmShim(logFile);
  const result = runHook(repoDir, {
    pathDirs: [pnpmDir, realGitDir, "/usr/bin", "/bin"],
    env: { MUSE_SKIP_PREPUSH_ALL: "1" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(logFile), []);
  assert.match(result.stderr, /ALL stages skipped/u);
});

test("a markdown push runs the reference gate and passes when every link resolves", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  installDocLinkChecker(repoDir);
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-log-")), "calls.txt");
  const localSha = writeAndCommit(repoDir, "docs/notes.md", "see [readme](../README.md)\n", "docs");
  const result = runHook(repoDir, {
    pathDirs: [makePnpmShim(logFile), realGitDir, path.dirname(process.execPath), "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /reference gate — node scripts\/check-doc-links\.mjs/u);
  assert.match(result.stderr, /every reference resolves/u);
});

test("a markdown push is BLOCKED when a documentation reference does not resolve", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  installDocLinkChecker(repoDir);
  const localSha = writeAndCommit(repoDir, "docs/notes.md", "see [gone](./does-not-exist.md)\n", "docs");
  const result = runHook(repoDir, {
    pathDirs: [realGitDir, path.dirname(process.execPath), "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /a documentation reference does not resolve/u);
});

test("a code-only push skips the reference gate", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  installDocLinkChecker(repoDir);
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-log-")), "calls.txt");
  const localSha = writeAndCommit(repoDir, "packages/x/src/a.ts", "export const a = 1;\n", "code");
  const result = runHook(repoDir, {
    pathDirs: [makePnpmShim(logFile), realGitDir, path.dirname(process.execPath), "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /reference gate skipped \(no markdown changed\)/u);
});

test("a markdown push in a tree without the checker says so instead of blocking", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "docs/notes.md", "docs only\n", "docs");
  const result = runHook(repoDir, {
    pathDirs: [realGitDir, path.dirname(process.execPath), "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /reference gate skipped \(scripts\/check-doc-links\.mjs not in this tree\)/u);
});
