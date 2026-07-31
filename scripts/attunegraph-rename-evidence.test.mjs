import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMMAND_MATRIX,
  assertCandidate,
  materializeCommandMatrix,
  parseTestCounts
} from "./run-attunegraph-rename-verification.mjs";
import {
  buildEvidence,
  canonicalIdentities,
  committedHashes,
  assertHistoricalRenameEvidenceCandidate
} from "./write-attunegraph-rename-evidence.mjs";
import { verifyEvidence } from "./verify-attunegraph-rename-evidence.mjs";

const command = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, stdio: "pipe" });
const receipts = (repo) => materializeCommandMatrix(repo).map(([name, argv], sequence) => ({ sequence, name, argv, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", exitCode: 0, testCounts: { passed: name.includes("test") ? 1 : 0, failed: 0 } }));
const receiptDocument = (repo) => ({
  baseline: repo.baseline,
  candidate: repo.candidate,
  receipts: receipts(repo),
  version: 1
});

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "attunegraph-evidence-"));
  command(cwd, "git", "init", "-q");
  command(cwd, "git", "config", "user.email", "test@example.invalid");
  command(cwd, "git", "config", "user.name", "test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  command(cwd, "git", "add", "README.md");
  command(cwd, "git", "commit", "-qm", "baseline");
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  mkdirSync(join(cwd, "packages/attunegraph/fixtures/portable-v1"), { recursive: true });
  writeFileSync(join(cwd, "packages/attunegraph/fixtures/portable-v1/fixture.atgx"), "canonical\n");
  writeFileSync(
    join(cwd, "packages/attunegraph/fixtures/portable-v1/identities.txt"),
    `${canonicalIdentities.join("\n")}\n`
  );
  command(cwd, "git", "add", ".");
  command(cwd, "git", "commit", "-qm", "candidate");
  return { cwd, baseline, candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim() };
}

test("evidence verifier rejects mutation cases", () => {
  const repo = repository();
  try {
    const evidence = buildEvidence({
      ...repo,
      receiptDocument: receiptDocument(repo)
    });
    assert.equal(verifyEvidence(evidence, repo), true);
    for (const mutate of [
      (value) => { value.receipts.pop(); },
      (value) => { value.receipts[1] = { ...value.receipts[0] }; },
      (value) => { value.receipts[0].exitCode = 1; },
      (value) => { value.hashes[0].sha256 = "0".repeat(64); },
      (value) => { value.identities[0] = "wrong"; },
      (value) => { value.diffPaths.push("outside.txt"); }
    ]) {
      const altered = structuredClone(evidence);
      mutate(altered);
      assert.throws(() => verifyEvidence(altered, repo));
    }
    writeFileSync(join(repo.cwd, "packages/attunegraph/fixtures/portable-v1/worktree-only.atgx"), "not committed\n");
    assert.equal(committedHashes(repo.candidate, repo.cwd).some((entry) => entry.path.endsWith("worktree-only.atgx")), false);
    rmSync(join(repo.cwd, "packages/attunegraph/fixtures/portable-v1/worktree-only.atgx"));
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("evidence writer rejects stale or rebound receipt documents", () => {
  const repo = repository();
  try {
    for (const mutate of [
      (value) => { value.version = 2; },
      (value) => { value.baseline = "0".repeat(40); },
      (value) => { value.candidate = "f".repeat(40); }
    ]) {
      const document = receiptDocument(repo);
      mutate(document);
      assert.throws(() => buildEvidence({
        ...repo,
        receiptDocument: document
      }));
    }
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("candidate checks reject wrong parent and dirty trees", () => {
  assert.throws(() => assertCandidate({ baseline: "base", candidate: "HEAD", resolve: (ref) => ref === "HEAD" ? "head" : "base", parent: () => "other", status: () => "" }));
  assert.throws(() => assertCandidate({ baseline: "base", candidate: "HEAD", resolve: (ref) => ref === "HEAD" ? "head" : "base", parent: () => "base", status: () => "?? worktree-only" }));
});

test("historical rename evidence explicitly retires when AttuneGraph is a gitlink", () => {
  const repo = repository();
  try {
    const output = "160000 commit 7bcac1cca6c3e9883b0faf9545df1a85985ddf64\tpackages/attunegraph\n";
    assert.throws(
      () => assertHistoricalRenameEvidenceCandidate(repo.candidate, repo.cwd, () => output),
      /retired for submodule candidates/u
    );
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("command receipts bind diff-check to the committed candidate range", () => {
  const commits = { baseline: "base-commit", candidate: "candidate-commit" };
  const matrix = materializeCommandMatrix(commits);
  assert.deepEqual(matrix[0], [
    "diff-check",
    ["git", "diff", "--check", "base-commit...candidate-commit"]
  ]);
  assert.deepEqual(COMMAND_MATRIX[0], [
    "diff-check",
    ["git", "diff", "--check", "{baseline}...{candidate}"]
  ]);
  assert.deepEqual(matrix.find(([name]) => name === "fixture-clean"), [
    "fixture-clean",
    ["git", "-C", "packages/attunegraph", "diff", "--exit-code", "HEAD", "--", "fixtures/portable-v1", "src/fixtures", "attunegraph-local-runtime-manifest.json"]
  ]);
});

test("evidence rejects a worktree-only diff-check receipt", () => {
  const repo = repository();
  try {
    const document = receiptDocument(repo);
    document.receipts[0].argv = ["git", "diff", "--check"];
    assert.throws(() => buildEvidence({
      ...repo,
      receiptDocument: document
    }));
  } finally {
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("test receipt parsing accepts current Node, legacy TAP, and Vitest summaries", () => {
  assert.deepEqual(parseTestCounts("ℹ pass 12\nℹ fail 0\n"), {
    failed: 0,
    passed: 12
  });
  assert.deepEqual(parseTestCounts("# pass 7\n# fail 1\n"), {
    failed: 1,
    passed: 7
  });
  assert.deepEqual(parseTestCounts("Tests 326 passed (326)\nTests 2 failed (328)\n"), {
    failed: 2,
    passed: 326
  });
});
