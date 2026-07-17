import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  collectFailedTrialCandidates,
  compareEvalArtifacts,
  promoteReviewedCase,
  runEvalEvidenceCli,
} from "./eval-evidence.mjs";

const execFileAsync = promisify(execFile);

const config = Object.freeze({
  infraRetries: 1,
  minRepeat: 0,
  repeat: 1,
  safetyCritical: false,
  threshold: 0.85,
});

function trial({
  attemptIndex = 0,
  caseId,
  cleanupFailure = false,
  contaminationMarker,
  failureKind,
  repeatIndex = 0,
  retryScheduled = false,
  status,
  traceRefs = [],
  trialConfig = config,
}) {
  return {
    attemptIndex,
    caseId,
    config: trialConfig,
    repeatIndex,
    result: {
      cleanupFailure,
      ...(contaminationMarker ? { contaminationMarker } : {}),
      ...(failureKind ? { failureKind } : {}),
      retryScheduled,
      status,
    },
    scenarioId: "scenario-1",
    schema: "muse.eval.trial/v1",
    suiteId: "suite-1",
    traceRefs,
  };
}

function artifact(trials, { safetyFloorViolations = [], skippedCases = 0 } = {}) {
  const terminal = trials.filter((entry) => !entry.result.retryScheduled);
  const cases = new Map();
  for (const entry of terminal) cases.set(entry.caseId, entry.result.status);
  const statuses = [...cases.values()];
  const excluded = statuses.filter((status) => status === "excluded").length;
  const counted = statuses.filter((status) => status !== "excluded");
  const passed = counted.filter((status) => status === "pass").length;
  const total = counted.length;
  return [
    ...trials,
    {
      artifact: { errors: 0, path: "results.jsonl" },
      counts: { executedAttempts: trials.length, skippedCases, trialRecords: trials.length },
      result: {
        excluded,
        flakeRetries: trials.filter((entry) => entry.result.status === "retry").length,
        passed,
        rate: total === 0 ? 0 : passed / total,
        safetyFloorViolations,
        total,
      },
      schema: "muse.eval.summary/v1",
      suiteId: "suite-1",
    },
  ];
}

test("failed-trial candidates — only a terminal case failure is promoted; recovered retry, pass, and excluded stay out", () => {
  const records = artifact([
    trial({ caseId: "recovered", failureKind: "infra-timeout", retryScheduled: true, status: "retry", traceRefs: ["trace/retry"] }),
    trial({ attemptIndex: 1, caseId: "recovered", status: "pass", traceRefs: ["trace/recovered"] }),
    trial({ caseId: "passed", status: "pass" }),
    trial({ caseId: "excluded", contaminationMarker: "null-observation", failureKind: "tier0-contamination", status: "excluded" }),
    trial({ caseId: "failed", failureKind: "semantic", status: "fail", traceRefs: ["trace/failed"] }),
  ]);

  const candidates = collectFailedTrialCandidates(records);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].schema, "muse.eval.case-candidate/v1");
  assert.equal(candidates[0].caseId, "failed");
  assert.deepEqual(candidates[0].failedRepeatIndexes, [0]);
  assert.deepEqual(candidates[0].failureKinds, ["semantic"]);
  assert.deepEqual(candidates[0].traceRefs, ["trace/failed"]);
  assert.match(candidates[0].sourceArtifactFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(candidates[0].candidateKey, /^[a-f0-9]{64}$/u);
});

test("artifact validation — truncated retries, duplicate attempts, impossible repeat order, and forged counts fail closed", () => {
  const recovered = artifact([
    trial({ caseId: "recovered", failureKind: "infra-timeout", retryScheduled: true, status: "retry" }),
    trial({ attemptIndex: 1, caseId: "recovered", status: "pass" }),
  ]);
  assert.throws(() => collectFailedTrialCandidates(recovered.slice(0, -1)), /invalid eval artifact/iu);

  const duplicate = structuredClone(recovered);
  duplicate.splice(1, 0, structuredClone(duplicate[0]));
  duplicate.at(-1).counts.executedAttempts = 3;
  duplicate.at(-1).counts.trialRecords = 3;
  duplicate.at(-1).result.flakeRetries = 2;
  assert.throws(() => collectFailedTrialCandidates(duplicate), /duplicate/iu);

  const truncated = artifact([
    trial({ caseId: "truncated", failureKind: "infra-timeout", retryScheduled: true, status: "retry" }),
  ]);
  assert.throws(() => collectFailedTrialCandidates(truncated), /truncated/iu);

  const repeatTwo = { ...config, repeat: 2 };
  const afterFailure = artifact([
    trial({ caseId: "impossible", failureKind: "semantic", status: "fail", trialConfig: repeatTwo }),
    trial({ caseId: "impossible", repeatIndex: 1, status: "pass", trialConfig: repeatTwo }),
  ]);
  assert.throws(() => collectFailedTrialCandidates(afterFailure), /no repeat may follow/iu);

  const forgedCount = structuredClone(recovered);
  forgedCount.at(-1).result.flakeRetries = 0;
  assert.throws(() => collectFailedTrialCandidates(forgedCount), /flakeRetries/iu);

  const smuggledPrompt = structuredClone(recovered);
  smuggledPrompt[0].prompt = "PRIVATE_PROMPT_MUST_NOT_BE_COPIED";
  assert.throws(() => collectFailedTrialCandidates(smuggledPrompt), /unknown field prompt/iu);

  const safetyConfig = { ...config, safetyCritical: true };
  const forgedSafetyFloor = artifact([trial({ caseId: "under-k", status: "pass", trialConfig: safetyConfig })]);
  assert.throws(() => collectFailedTrialCandidates(forgedSafetyFloor), /safety.*violation/iu);

  const forgedCleanupPass = artifact([trial({ caseId: "cleanup-pass", status: "pass" })]);
  forgedCleanupPass[0].result.cleanupFailure = true;
  assert.throws(() => collectFailedTrialCandidates(forgedCleanupPass), /cleanup.*fail/iu);

  const missingFailureKind = artifact([trial({ caseId: "missing-kind", status: "fail" })]);
  assert.throws(() => collectFailedTrialCandidates(missingFailureKind), /failureKind/iu);

  const overRetry = artifact([
    trial({ caseId: "too-many-retries", failureKind: "infra-timeout", retryScheduled: true, status: "retry" }),
    trial({ attemptIndex: 1, caseId: "too-many-retries", failureKind: "infra-timeout", retryScheduled: true, status: "retry" }),
    trial({ attemptIndex: 2, caseId: "too-many-retries", status: "pass" }),
  ]);
  assert.throws(() => collectFailedTrialCandidates(overRetry), /retry budget/iu);
});

test("reviewed-case promotion — explicit redaction approval binds the exact candidate and emits no local source identifiers", () => {
  const source = artifact([
    trial({ caseId: "private-case-94f2", failureKind: "semantic", status: "fail", traceRefs: ["trace/private-run-94f2"] }),
  ]);
  const candidate = collectFailedTrialCandidates(source)[0];
  const review = {
    case: {
      expected: { outcome: "refuse-unsafe-action" },
      id: "redacted-refusal-1",
      input: { utterance: "Perform the deliberately redacted unsafe action" },
      scenarioId: "redacted-safety",
      tags: ["regression", "reviewed"],
      title: "Redacted unsafe-action refusal",
    },
    decision: "promote",
    redactionConfirmed: true,
    schema: "muse.eval.case-review/v1",
    sourceCandidateKey: candidate.candidateKey,
  };

  const promoted = promoteReviewedCase(candidate, review);
  const serialized = JSON.stringify(promoted);
  assert.equal(promoted.schema, "muse.eval.case/v1");
  assert.match(promoted.sourceFingerprint, /^[a-f0-9]{64}$/u);
  for (const localValue of [candidate.candidateKey, candidate.caseId, candidate.scenarioId, ...candidate.traceRefs]) {
    assert.equal(serialized.includes(localValue), false);
  }

  const changedSource = structuredClone(source);
  changedSource[0].traceRefs = ["trace/different-reviewed-run"];
  const changedFailure = structuredClone(source);
  changedFailure[0].result.failureKind = "solver-error";
  const changedRepeat = structuredClone(source);
  changedRepeat[0].config = { ...changedRepeat[0].config, repeat: 2 };
  const changedArtifact = structuredClone(source);
  changedArtifact.at(-1).counts.skippedCases = 1;
  for (const mutatedSource of [changedSource, changedFailure, changedRepeat, changedArtifact]) {
    const changedCandidate = collectFailedTrialCandidates(mutatedSource)[0];
    assert.notEqual(changedCandidate.candidateKey, candidate.candidateKey);
    assert.throws(() => promoteReviewedCase(changedCandidate, review), /candidate/iu);
  }

  const changedReview = structuredClone(review);
  changedReview.case.expected.outcome = "different-redacted-outcome";
  assert.notEqual(promoteReviewedCase(candidate, changedReview).sourceFingerprint, promoted.sourceFingerprint);
  assert.throws(() => promoteReviewedCase(candidate, { ...review, redactionConfirmed: false }), /redaction/iu);

  const substringLeak = structuredClone(review);
  substringLeak.case.expected.outcome = `prefix-${candidate.caseId}-suffix`;
  assert.throws(() => promoteReviewedCase(candidate, substringLeak), /local candidate identifier/iu);
  const keyLeak = structuredClone(review);
  keyLeak.case.input = { [candidate.traceRefs[0]]: "redacted value" };
  assert.throws(() => promoteReviewedCase(candidate, keyLeak), /local candidate identifier/iu);
});

test("baseline delta — classifies per composite case key and fails for regressions, new/current failures, removals, or a false current semantic gate", () => {
  const baseline = artifact([
    trial({ caseId: "fixed", failureKind: "semantic", status: "fail" }),
    trial({ caseId: "regressed", status: "pass" }),
    trial({ caseId: "stable-pass", status: "pass" }),
    trial({ caseId: "stable-fail", failureKind: "semantic", status: "fail" }),
    trial({ caseId: "was-excluded", contaminationMarker: "null-observation", failureKind: "tier0-contamination", status: "excluded" }),
    trial({ caseId: "removed", status: "pass" }),
  ]);
  const current = artifact([
    trial({ caseId: "fixed", status: "pass" }),
    trial({ caseId: "regressed", failureKind: "semantic", status: "fail" }),
    trial({ caseId: "stable-pass", status: "pass" }),
    trial({ caseId: "stable-fail", failureKind: "semantic", status: "fail" }),
    trial({ caseId: "was-excluded", failureKind: "semantic", status: "fail" }),
    trial({ caseId: "new-pass", status: "pass" }),
    trial({ caseId: "new-fail", failureKind: "semantic", status: "fail" }),
  ]);

  const report = compareEvalArtifacts(baseline, current);
  const byCase = new Map(report.cases.map((entry) => [entry.caseId, entry]));
  assert.equal(byCase.get("fixed").classification, "improved");
  assert.equal(byCase.get("regressed").classification, "regressed");
  assert.equal(byCase.get("stable-pass").classification, "unchanged");
  assert.equal(byCase.get("stable-fail").classification, "unchanged");
  assert.equal(byCase.get("was-excluded").classification, "regressed");
  assert.equal(byCase.get("removed").classification, "unverified");
  assert.equal(byCase.get("new-pass").classification, "new");
  assert.equal(byCase.get("new-fail").classification, "new");
  assert.equal(byCase.get("new-fail").currentStatus, "fail");
  assert.equal(report.gate, false);

  const unchangedPass = artifact([trial({ caseId: "stable-pass", status: "pass" })]);
  const underKConfig = { ...config, safetyCritical: true };
  const underK = artifact(
    [trial({ caseId: "stable-pass", status: "pass", trialConfig: underKConfig })],
    { safetyFloorViolations: [{ actualRepeat: 1, kind: "repeat-floor", requiredRepeat: 3, scenarioId: "scenario-1" }] },
  );
  const safetyReport = compareEvalArtifacts(unchangedPass, underK);
  assert.equal(safetyReport.cases[0].classification, "unchanged");
  assert.equal(safetyReport.currentSemanticGate, false);
  assert.equal(safetyReport.gate, false);
});

test("eval-evidence CLI — full local pipeline reads only named inputs, survives a network trap, writes private outputs, and never overwrites or follows symlink parents", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "muse-eval-evidence-"));
  const baselinePath = join(root, "baseline.jsonl");
  const currentPath = join(root, "current.jsonl");
  const candidatesPath = join(root, "candidates.jsonl");
  const reviewPath = join(root, "review.json");
  const promotedPath = join(root, "promoted-case.json");
  const deltaPath = join(root, "delta.json");
  const networkTrapPath = join(root, "network-trap.mjs");
  const traceTrap = join(root, "trace", "unreadable-source");
  try {
    await mkdir(traceTrap, { recursive: true });
    await chmod(traceTrap, 0o000);
    const baseline = artifact([
      trial({ caseId: "private-case-94f2", failureKind: "semantic", status: "fail", traceRefs: ["trace/unreadable-source"] }),
    ]);
    const current = artifact([trial({ caseId: "private-case-94f2", status: "pass" })]);
    await writeFile(baselinePath, `${baseline.map(JSON.stringify).join("\n")}\n`, "utf8");
    await writeFile(currentPath, `${current.map(JSON.stringify).join("\n")}\n`, "utf8");

    const reads = [];
    const allowOnly = (...allowedPaths) => async (path) => {
      const absolute = resolve(path);
      reads.push(absolute);
      if (!allowedPaths.map((allowedPath) => resolve(allowedPath)).includes(absolute)) throw new Error(`unexpected read: ${absolute}`);
      return readFile(absolute, "utf8");
    };
    await runEvalEvidenceCli(
      ["--", "candidates", "--artifact", baselinePath, "--out", candidatesPath],
      { log() {}, readText: allowOnly(baselinePath) },
    );
    assert.deepEqual(reads, [baselinePath]);
    const candidate = JSON.parse((await readFile(candidatesPath, "utf8")).trim());
    const review = {
      case: {
        expected: { outcome: "safe-result" },
        id: "reviewed-redacted-1",
        input: { utterance: "A deliberately redacted regression input" },
        scenarioId: "reviewed-regression",
        tags: ["reviewed"],
        title: "Reviewed redacted regression",
      },
      decision: "promote",
      redactionConfirmed: true,
      schema: "muse.eval.case-review/v1",
      sourceCandidateKey: candidate.candidateKey,
    };
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`, "utf8");
    reads.length = 0;
    await runEvalEvidenceCli(
      ["promote", "--candidates", candidatesPath, "--review", reviewPath, "--out", promotedPath],
      { log() {}, readText: allowOnly(candidatesPath, reviewPath) },
    );
    assert.deepEqual(reads.sort(), [candidatesPath, reviewPath].sort());
    const promotedBytes = await readFile(promotedPath, "utf8");
    assert.equal(promotedBytes.includes("private-case-94f2"), false);
    assert.equal(promotedBytes.includes("trace/unreadable-source"), false);

    reads.length = 0;
    await runEvalEvidenceCli(
      ["compare", "--baseline", baselinePath, "--current", currentPath, "--out", deltaPath],
      { log() {}, readText: allowOnly(baselinePath, currentPath) },
    );
    assert.deepEqual(reads.sort(), [baselinePath, currentPath].sort());
    const delta = JSON.parse(await readFile(deltaPath, "utf8"));
    assert.equal(delta.cases[0].classification, "improved");
    assert.equal(delta.gate, true);
    if (process.platform === "win32") {
      const verifyAcl = [
        "$acl = Get-Acl -LiteralPath $env:MUSE_EVAL_EVIDENCE_PATH;",
        "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;",
        "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]));",
        "if (-not $acl.AreAccessRulesProtected -or $rules.Count -eq 0) { exit 21 };",
        "foreach ($rule in $rules) { if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow') { exit 22 } };",
      ].join(" ");
      for (const path of [candidatesPath, promotedPath, deltaPath]) {
        await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", verifyAcl], {
          env: { ...process.env, MUSE_EVAL_EVIDENCE_PATH: path },
          windowsHide: true,
        });
      }
    } else {
      for (const path of [candidatesPath, promotedPath, deltaPath]) assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    await assert.rejects(
      runEvalEvidenceCli(["compare", "--baseline", baselinePath, "--current", currentPath, "--out", deltaPath], { log() {} }),
      /exist|exclusive/iu,
    );

    const realOutputDir = join(root, "real-output");
    const linkedOutputDir = join(root, "linked-output");
    await mkdir(realOutputDir);
    await symlink(realOutputDir, linkedOutputDir, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      runEvalEvidenceCli(
        ["candidates", "--artifact", baselinePath, "--out", join(linkedOutputDir, "blocked.jsonl")],
        { log() {} },
      ),
      /symlink/iu,
    );

    await writeFile(networkTrapPath, [
      "import http from 'node:http';",
      "import https from 'node:https';",
      "import net from 'node:net';",
      "const blocked = () => { throw new Error('network access forbidden in eval evidence CLI'); };",
      "globalThis.fetch = blocked;",
      "http.request = blocked; http.get = blocked;",
      "https.request = blocked; https.get = blocked;",
      "net.connect = blocked; net.createConnection = blocked;",
    ].join("\n"), "utf8");
    const trappedOutput = join(root, "network-trapped-candidates.jsonl");
    await execFileAsync(process.execPath, [
      "--import", networkTrapPath,
      join(process.cwd(), "scripts", "eval-evidence.mjs"),
      "candidates", "--artifact", baselinePath, "--out", trappedOutput,
    ]);
    assert.equal((await readFile(trappedOutput, "utf8")).trim().length > 0, true);

    const windowsOrderOutput = join(root, "windows-order-candidates.jsonl");
    let bytesVisibleBeforeAcl;
    await runEvalEvidenceCli(
      ["candidates", "--artifact", baselinePath, "--out", windowsOrderOutput],
      {
        log() {},
        outputSystem: {
          platform: "win32",
          protectWindowsOutput: async (path) => {
            bytesVisibleBeforeAcl = await readFile(path, "utf8");
          },
        },
      },
    );
    assert.equal(bytesVisibleBeforeAcl, "", "Windows ACL protection must complete before sensitive bytes are written");
    assert.equal((await readFile(windowsOrderOutput, "utf8")).trim().length > 0, true);

    const failedDeltaPath = join(root, "failed-delta.json");
    await assert.rejects(
      execFileAsync(process.execPath, [
        join(process.cwd(), "scripts", "eval-evidence.mjs"),
        "compare", "--baseline", baselinePath, "--current", baselinePath, "--out", failedDeltaPath,
      ]),
      (error) => error.code === 1 && /delta gate FAIL/iu.test(error.stdout),
    );
  } finally {
    await chmod(traceTrap, 0o700).catch(() => {});
    await rm(root, { force: true, recursive: true });
  }
});
