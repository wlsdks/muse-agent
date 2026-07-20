import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BUILDER_HARD_CAPS,
  BUILDER_P95_INFORMATIONAL_BUDGET_MS,
  CASES_PER_CELL,
  CASE_COUNT,
  CATEGORIES,
  CHILD_SCHEMA_VERSION,
  CHILD_TIMEOUT_MS,
  DATASET_SHA256,
  DIAGNOSTICS_ROOT_RELATIVE,
  DOMAINS,
  EXECUTION_COUNT,
  FAILURE_CODES,
  LOCALES,
  ORDER_NAMES,
  PARENT_TIMEOUT_MS,
  POSITION_BIAS_DATASET,
  RESULT_SCHEMA_VERSION,
  RUNTIME_SOURCE_IDS,
  buildDevelopmentResult,
  buildExpectedSelectorCards,
  canonicalJson,
  formatPositionBiasFailure,
  orderedCandidates,
  positionBiasFailureCode,
  remapVerifiedPair,
  runWithIsolationCleanup,
  runWithOwnerStateGuard,
  scoreBiasCase,
  sha256,
  summarizeBiasOutcomes,
  summarizeBuilderDiagnostics,
  validateBiasDiagnosticAccounting,
  validateBuilderDiagnostics,
  validateChildPayload,
  validateDataset,
  validateDevelopmentResult
} from "./eval-recall-position-bias-dev40.mjs";

const successfulDecision = Object.freeze({ eligible: true, httpAttempts: 1, logicalInvocations: 1, outcome: "success" });

function executionFor(testCase, orderName, selection = testCase.expectedPair, decision = successfulDecision) {
  const ordered = orderedCandidates(testCase, orderName);
  const productionOriginal = orderName === "original";
  return {
    accounting: {
      answerRequests: 0,
      controlRequests: 0,
      deniedExternalRequests: 0,
      embeddingRequests: productionOriginal ? 1 : 0,
      otherLoopbackRequests: 0,
      preloadRequests: productionOriginal ? 1 : 0,
      selectorRequests: 1,
      totalLoopbackRequests: productionOriginal ? 3 : 1
    },
    decision,
    firstCurrentId: ordered.find((item) => item.state === "current").id,
    firstStaleId: ordered.find((item) => item.state === "stale").id,
    selection
  };
}

function completeOutcomes() {
  return POSITION_BIAS_DATASET.map((testCase) => scoreBiasCase(testCase, {
    original: executionFor(testCase, "original"),
    reversed: executionFor(testCase, "reversed")
  }));
}

function completeNetworkAccounting() {
  return {
    answerRequests: 0,
    controlRequests: 2,
    deniedExternalRequests: 0,
    embeddingRequests: CASE_COUNT,
    otherLoopbackRequests: 0,
    preloadRequests: CASE_COUNT,
    selectorRequests: EXECUTION_COUNT,
    totalLoopbackRequests: 2 + CASE_COUNT * 2 + EXECUTION_COUNT
  };
}

function builderMeasurements({ candidates = 6, comparisons = 16, durationMs = 0.25, proposals = 6 } = {}) {
  return Array.from({ length: EXECUTION_COUNT }, () => ({
    diagnostics: { candidateCount: candidates, compatibilityComparisons: comparisons, proposalCount: proposals },
    durationMs
  }));
}

function completeBuilderDiagnostics(options) {
  return summarizeBuilderDiagnostics(builderMeasurements(options));
}

function completeModel() {
  return { digest: "a".repeat(64), modelTag: "actual-default:latest", ollamaVersion: "0.32.0", resolution: "actual-default", resolvedTag: "actual-default:latest" };
}

function completeChildPayload() {
  return {
    builderDiagnostics: completeBuilderDiagnostics(),
    model: completeModel(),
    networkAccounting: completeNetworkAccounting(),
    outcomes: completeOutcomes(),
    schemaVersion: CHILD_SCHEMA_VERSION
  };
}

function completeResult(outcomes = completeOutcomes(), builderDiagnostics = completeBuilderDiagnostics()) {
  return buildDevelopmentResult({
    builderDiagnostics,
    model: completeModel(),
    networkAccounting: completeNetworkAccounting(),
    outcomes,
    ownerState: { afterSha256: "b".repeat(64), beforeSha256: "b".repeat(64), unchanged: true },
    runMetadata: { generatedAt: "2030-01-01T00:00:00.000Z", node: "v24.0.0", platform: "darwin/arm64" },
    runtimeSources: RUNTIME_SOURCE_IDS.map((sourceId) => ({ sha256: "c".repeat(64), sourceId }))
  });
}

test("visible dev dataset has the exact 2 x 2 x 5 x 2 matrix and closed pair identities", () => {
  assert.equal(validateDataset(POSITION_BIAS_DATASET), POSITION_BIAS_DATASET);
  assert.equal(POSITION_BIAS_DATASET.length, CASE_COUNT);
  assert.equal(CASE_COUNT, 40);
  assert.equal(CASES_PER_CELL, 2);
  assert.deepEqual(CATEGORIES, ["pair-present", "no-pair"]);
  assert.deepEqual(LOCALES, ["ko", "en"]);
  assert.deepEqual(DOMAINS, ["life", "health", "work", "preference", "reference"]);
  assert.match(DATASET_SHA256, /^[a-f0-9]{64}$/u);
  for (const category of CATEGORIES) for (const locale of LOCALES) for (const domain of DOMAINS) {
    const cell = POSITION_BIAS_DATASET.filter((item) => item.category === category && item.locale === locale && item.domain === domain);
    assert.equal(cell.length, 2, `${category}/${locale}/${domain}`);
    assert.deepEqual(cell.map((item) => item.variant), [1, 2]);
  }
  for (const testCase of POSITION_BIAS_DATASET) {
    assert.equal(testCase.candidates.filter((item) => item.state === "current").length, 4);
    assert.equal(testCase.candidates.filter((item) => item.state === "stale").length, 4);
    assert.ok(testCase.candidates.every((item) => /^[a-f0-9]{16}$/u.test(item.id)));
    assert.equal(testCase.category === "pair-present", testCase.expectedPair !== null);
  }
});

test("reversed order changes only positions inside current and stale groups", () => {
  assert.deepEqual(ORDER_NAMES, ["original", "reversed"]);
  for (const testCase of POSITION_BIAS_DATASET) {
    const original = orderedCandidates(testCase, "original");
    const reversed = orderedCandidates(testCase, "reversed");
    const originalCurrent = original.filter((item) => item.state === "current").map((item) => item.id);
    const originalStale = original.filter((item) => item.state === "stale").map((item) => item.id);
    assert.deepEqual(reversed.filter((item) => item.state === "current").map((item) => item.id), [...originalCurrent].reverse());
    assert.deepEqual(reversed.filter((item) => item.state === "stale").map((item) => item.id), [...originalStale].reverse());
    assert.deepEqual(new Set(reversed.map((item) => item.id)), new Set(original.map((item) => item.id)));
    assert.equal(reversed.slice(0, 4).every((item) => item.state === "current"), true);
    assert.equal(reversed.slice(4).every((item) => item.state === "stale"), true);
  }
});

test("selector prompt auditor mirrors exact sorted pair-card rendering without a first-pair shortcut", () => {
  const texts = ["current A", "current B", "stale A", "stale B"];
  assert.deepEqual(buildExpectedSelectorCards(texts, [
    { current: 1, stale: 3 },
    { current: 0, stale: 2 }
  ]), [
    "PAIR CARD 1\nexact tuple: {\"current\":1,\"stale\":3}\ncurrent text [1]: current A\nstale text [3]: stale A",
    "PAIR CARD 2\nexact tuple: {\"current\":2,\"stale\":4}\ncurrent text [2]: current B\nstale text [4]: stale B"
  ]);
  assert.throws(() => buildExpectedSelectorCards(texts, []), /SELECTOR_ORDER_DRIFT/u);
});

test("verified production file identities remap to the same original opaque pair in both executions", () => {
  const testCase = POSITION_BIAS_DATASET.find((item) => item.category === "pair-present");
  const originalMap = new Map([["/isolated/original/current", testCase.expectedPair.current], ["/isolated/original/stale", testCase.expectedPair.stale]]);
  const reversedMap = new Map([["/isolated/reversed/current", testCase.expectedPair.current], ["/isolated/reversed/stale", testCase.expectedPair.stale]]);
  const original = remapVerifiedPair({ current: { chunkIndex: 0, file: "/isolated/original/current" }, stale: { chunkIndex: 0, file: "/isolated/original/stale" } }, originalMap);
  const reversed = remapVerifiedPair({ current: { chunkIndex: 0, file: "/isolated/reversed/current" }, stale: { chunkIndex: 0, file: "/isolated/reversed/stale" } }, reversedMap);
  assert.deepEqual(original, testCase.expectedPair);
  assert.deepEqual(reversed, testCase.expectedPair);
  assert.equal(remapVerifiedPair(undefined, new Map()), null);
  assert.throws(() => remapVerifiedPair({ current: { chunkIndex: 1, file: "x" }, stale: { chunkIndex: 0, file: "y" } }, new Map()), /PAIR_IDENTITY_INVALID/);
  assert.throws(() => remapVerifiedPair({ current: { chunkIndex: 0, file: "unknown" }, stale: { chunkIndex: 0, file: "also-unknown" } }, new Map()), /PAIR_IDENTITY_INVALID/);
});

test("agreement is measured separately and same-wrong can never satisfy the objective gates", () => {
  const outcomes = completeOutcomes();
  const testCase = POSITION_BIAS_DATASET.find((item) => item.category === "pair-present");
  const wrongCurrent = testCase.candidates.find((item) => item.state === "current" && item.id !== testCase.expectedPair.current).id;
  const wrongStale = testCase.candidates.find((item) => item.state === "stale" && item.id !== testCase.expectedPair.stale).id;
  const wrongPair = { current: wrongCurrent, stale: wrongStale };
  const changed = scoreBiasCase(testCase, {
    original: executionFor(testCase, "original", wrongPair),
    reversed: executionFor(testCase, "reversed", wrongPair)
  });
  const index = POSITION_BIAS_DATASET.indexOf(testCase);
  outcomes[index] = changed;
  const summary = summarizeBiasOutcomes(outcomes);
  assert.equal(changed.agreement, true);
  assert.equal(changed.original.correct, false);
  assert.equal(changed.reversed.correct, false);
  assert.equal(summary.metrics.pairPresent.agreement, 20);
  assert.equal(summary.metrics.pairPresent.originalCorrect, 19);
  assert.equal(summary.metrics.pairPresent.reversedCorrect, 19);
  assert.equal(summary.gates.pairPresentAgreement, true);
  assert.equal(summary.gates.pairPresentOriginalCorrect, false);
  assert.equal(summary.gates.pairPresentReversedCorrect, false);
  assert.equal(summary.passed, false);
  const result = completeResult(outcomes);
  assert.equal(validateDevelopmentResult(result), result);
  assert.equal(result.payload.qualification.developmentGatesPassed, false);
});

test("hard metrics keep pair-present, no-pair, correctness, and agreement denominators separate", () => {
  const summary = summarizeBiasOutcomes(completeOutcomes());
  assert.deepEqual(summary.metrics, {
    noPair: { agreement: 20, originalCorrect: 20, reversedCorrect: 20, total: 20 },
    pairPresent: { agreement: 20, originalCorrect: 20, reversedCorrect: 20, total: 20 }
  });
  assert.equal(summary.passed, true);
  assert.equal(summary.gates.selectorExecution, true);
  assert.deepEqual(summary.positionDiagnostic.firstPositionSelection.original, {
    bothFirst: 20,
    currentFirst: 20,
    selectedPairs: 20,
    staleFirst: 20,
    totalExecutions: 40
  });
  assert.deepEqual(summary.positionDiagnostic.firstPositionSelection.reversed, {
    bothFirst: 0,
    currentFirst: 0,
    selectedPairs: 20,
    staleFirst: 0,
    totalExecutions: 40
  });
});

test("biasDiagnostic accounting is separate, observed, and rejects answer, external, unknown, and selector overflow", () => {
  const observed = completeNetworkAccounting();
  assert.equal(validateBiasDiagnosticAccounting(observed), observed);
  for (const key of ["answerRequests", "deniedExternalRequests", "otherLoopbackRequests"]) {
    const mutated = { ...observed, [key]: 1 };
    if (key !== "deniedExternalRequests") mutated.totalLoopbackRequests += 1;
    assert.throws(() => validateBiasDiagnosticAccounting(mutated), /NETWORK_ACCOUNTING_MISMATCH/);
  }
  assert.throws(() => validateBiasDiagnosticAccounting({ ...observed, selectorRequests: EXECUTION_COUNT + 1, totalLoopbackRequests: observed.totalLoopbackRequests + 1 }), /NETWORK_ACCOUNTING_MISMATCH/);
  assert.throws(() => validateBiasDiagnosticAccounting({ ...observed, prompt: "raw" }), /NETWORK_ACCOUNTING_MISMATCH/);
  assert.throws(() => validateBiasDiagnosticAccounting({ ...observed, totalLoopbackRequests: observed.totalLoopbackRequests + 1 }), /NETWORK_ACCOUNTING_MISMATCH/);
});

test("builder diagnostics aggregate exactly 80 seam calls and hard-gate only bounded work", () => {
  const diagnostics = completeBuilderDiagnostics();
  assert.equal(validateBuilderDiagnostics(diagnostics), diagnostics);
  assert.deepEqual(diagnostics, {
    maxCandidates: 6,
    maxComparisons: 16,
    maxMs: 0.25,
    maxProposals: 6,
    p95InformationalBudgetMs: 10,
    p95Ms: 0.25,
    p95WithinInformationalBudget: true,
    samples: 80
  });
  assert.deepEqual(BUILDER_HARD_CAPS, { maxCandidates: 12, maxComparisons: 100, maxProposals: 6 });
  assert.equal(BUILDER_P95_INFORMATIONAL_BUDGET_MS, 10);

  const slow = completeBuilderDiagnostics({ durationMs: 20 });
  const slowResult = completeResult(completeOutcomes(), slow);
  assert.equal(slow.p95WithinInformationalBudget, false);
  assert.equal(validateDevelopmentResult(slowResult), slowResult);
  assert.equal(slowResult.payload.qualification.gates.builderCaps, true);
  assert.equal(slowResult.payload.qualification.developmentGatesPassed, true);

  const overCap = completeBuilderDiagnostics({ comparisons: 101 });
  const cappedResult = completeResult(completeOutcomes(), overCap);
  assert.equal(validateDevelopmentResult(cappedResult), cappedResult);
  assert.equal(cappedResult.payload.qualification.gates.builderCaps, false);
  assert.equal(cappedResult.payload.qualification.developmentGatesPassed, false);
});

test("parent child-schema rejects model extras, raw outcome fields, and unknown decision outcomes before result assembly", () => {
  const child = completeChildPayload();
  assert.equal(validateChildPayload(child), child);

  const modelExtra = structuredClone(child);
  modelExtra.model.transportPath = "/Users/private/model";
  assert.throws(() => validateChildPayload(modelExtra), /CHILD_OUTPUT_INVALID/);

  const outcomeExtra = structuredClone(child);
  outcomeExtra.outcomes[0].rawCandidateText = "private raw candidate";
  assert.throws(() => validateChildPayload(outcomeExtra), /CHILD_OUTPUT_INVALID/);

  const decisionOutcome = structuredClone(child);
  decisionOutcome.outcomes[0].original.decision.outcome = "raw-prompt-forwarded";
  assert.throws(() => validateChildPayload(decisionOutcome), /CHILD_OUTPUT_INVALID/);

  for (const rejected of [modelExtra, outcomeExtra, decisionOutcome]) {
    let error;
    try { validateChildPayload(rejected); }
    catch (cause) { error = cause; }
    assert.equal(formatPositionBiasFailure(error), "CHILD_OUTPUT_INVALID\n");
    assert.doesNotMatch(formatPositionBiasFailure(error), /Users|private|candidate|prompt/iu);
  }
});

test("development result exposes only aggregate diagnostics and cannot claim held-out or organic evidence", () => {
  const result = completeResult();
  assert.equal(validateDevelopmentResult(result), result);
  assert.equal(result.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(result.payload.accounting.biasDiagnostic.caseExecutions, 40);
  assert.equal(result.payload.accounting.productionOriginal.caseExecutions, 40);
  assert.equal(result.payload.accounting.biasDiagnostic.embeddingRequests, 0);
  assert.equal(result.payload.accounting.productionOriginal.embeddingRequests, 40);
  assert.equal(result.payload.accounting.biasDiagnostic.selectorRequests, 40);
  assert.equal(result.payload.accounting.productionOriginal.selectorRequests, 40);
  assert.equal(result.payload.accounting.biasDiagnostic.answerRequests, 0);
  assert.equal(result.payload.accounting.biasDiagnostic.externalRequests, 0);
  assert.equal(result.payload.accounting.biasDiagnostic.unknownRequests, 0);
  assert.equal(result.payload.builderDiagnostics.samples, 80);
  assert.equal(result.payload.builderDiagnostics.maxComparisons <= 100, true);
  assert.equal(result.payload.builderDiagnostics.maxProposals <= 6, true);
  assert.equal(result.payload.builderDiagnostics.maxCandidates <= 12, true);
  assert.equal(result.payload.qualification.developmentGatesPassed, true);
  assert.equal(result.payload.qualification.status, "DEVELOPMENT_ONLY");
  assert.equal(result.payload.dataset.heldOut, false);
  assert.equal(result.payload.dataset.organicEvidence, false);
  assert.doesNotMatch(canonicalJson(result), /\/Users\/|\/home\/|candidateText|rawPrompt|promptText|notesDir|queryText/iu);

  const forged = structuredClone(result);
  forged.payload.dataset.heldOut = true;
  forged.payloadHash = sha256(`${canonicalJson(forged.payload)}\n`);
  assert.throws(() => validateDevelopmentResult(forged), /CHILD_OUTPUT_INVALID/);

  const modelExtra = structuredClone(result);
  modelExtra.payload.model.rawTransport = "/home/private/model";
  modelExtra.payloadHash = sha256(`${canonicalJson(modelExtra.payload)}\n`);
  assert.throws(() => validateDevelopmentResult(modelExtra), /CHILD_OUTPUT_INVALID/);

  const resultExtra = structuredClone(result);
  resultExtra.rawPrompt = "must not pass";
  assert.throws(() => validateDevelopmentResult(resultExtra), /CHILD_OUTPUT_INVALID/);
});

test("owner after-manifest is hash-only and always captured in finally", async () => {
  const digest = "d".repeat(64);
  const captures = [];
  const writes = [];
  let thrown;
  try {
    await runWithOwnerStateGuard({
      afterPath: "/isolated/after.json",
      beforePath: "/isolated/before.json",
      capture: async (root) => { captures.push(root); return { entries: [{ path: "private.md" }], manifestSha256: digest }; },
      ownerRoot: "/owner/.muse",
      run: async () => { throw new Error("/Users/private raw candidate"); },
      write: async (_path, value) => { writes.push(value); }
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(captures.length, 2);
  assert.equal(writes.length, 2);
  assert.ok(writes.every((value) => canonicalJson(JSON.parse(value)) === canonicalJson({ manifestSha256: digest })));
  assert.equal(formatPositionBiasFailure(thrown), "POSITION_BIAS_EVAL_FAILED\n");
  assert.doesNotMatch(formatPositionBiasFailure(thrown), /Users|private|candidate|at\s/iu);
});

test("isolation HOME cleanup runs after success, failure, and timeout while preserving the original failure", async () => {
  const removals = [];
  const remove = async (path, options) => { removals.push({ options, path }); };
  const inspect = async () => {
    const error = new Error("missing");
    Object.defineProperty(error, "code", { value: "ENOENT" });
    throw error;
  };
  const common = { allowedRoot: "/isolated", home: "/isolated/run/home", inspect, remove, sessionDir: "/isolated/run" };
  assert.equal(await runWithIsolationCleanup({ ...common, run: async () => "ok" }), "ok");

  let failureError;
  try {
    await runWithIsolationCleanup({ ...common, run: async () => { throw new Error("raw candidate failure"); } });
  } catch (error) {
    failureError = error;
  }
  assert.equal(positionBiasFailureCode(failureError), "POSITION_BIAS_EVAL_FAILED");

  let timeoutError;
  try {
    await runWithIsolationCleanup({ ...common, run: async () => { throw Object.assign(new Error("timeout path"), { code: "CHILD_TIMEOUT" }); } });
  } catch (error) {
    timeoutError = error;
  }
  assert.equal(positionBiasFailureCode(timeoutError), "CHILD_TIMEOUT");
  assert.equal(removals.length, 3);
  assert.ok(removals.every(({ options, path }) => path === "/isolated/run/home" && canonicalJson(options) === canonicalJson({ force: true, recursive: true })));
});

test("isolation cleanup removes raw fixture files and fails closed on remove errors or a residual root", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "muse-position-bias-cleanup-"));
  const sessionDir = join(temporaryRoot, "session");
  const home = join(sessionDir, "home");
  try {
    await mkdir(join(home, "notes"), { mode: 0o700, recursive: true });
    await writeFile(join(home, "notes", "raw-candidate.md"), "raw synthetic candidate", { mode: 0o600 });
    assert.equal(await runWithIsolationCleanup({ allowedRoot: temporaryRoot, home, run: async () => 42, sessionDir }), 42);
    await assert.rejects(lstat(home), (error) => error?.code === "ENOENT");

    await assert.rejects(
      runWithIsolationCleanup({
        allowedRoot: temporaryRoot,
        home,
        inspect: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
        remove: async () => { throw new Error("remove failed"); },
        run: async () => "ignored",
        sessionDir
      }),
      (error) => positionBiasFailureCode(error) === "ISOLATION_CLEANUP_FAILED"
    );
    await assert.rejects(
      runWithIsolationCleanup({
        allowedRoot: temporaryRoot,
        home,
        inspect: async () => ({ residual: true }),
        remove: async () => {},
        run: async () => "ignored",
        sessionDir
      }),
      (error) => positionBiasFailureCode(error) === "ISOLATION_CLEANUP_FAILED"
    );
    await assert.rejects(
      runWithIsolationCleanup({ allowedRoot: temporaryRoot, home: sessionDir, run: async () => "unsafe", sessionDir }),
      (error) => positionBiasFailureCode(error) === "ISOLATION_CLEANUP_FAILED"
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("runner is bounded, production-path based, and default-model resolved", () => {
  assert.equal(CHILD_TIMEOUT_MS, 20 * 60_000);
  assert.equal(PARENT_TIMEOUT_MS, 30 * 60_000);
  assert.equal(DIAGNOSTICS_ROOT_RELATIVE, ".muse-dev/evals/recall-position-bias-dev40");
  const source = readFileSync(new URL("./eval-recall-position-bias-dev40.mjs", import.meta.url), "utf8");
  assert.match(source, /apps\/cli\/dist\/ask-note-retrieval\.js/u);
  assert.match(source, /packages\/recall\/dist/u);
  assert.match(source, /resolveRerankModel/u);
  assert.match(source, /MUSE_RECALL_RERANK:\s*"true"/u);
  assert.match(source, /createAuditedLoopbackFetch/u);
  assert.match(source, /buildCorrectionPairShortlist/u);
  assert.match(source, /buildCorrectionPairRerankContext/u);
  assert.match(source, /resolveCorrectionPairSelection/u);
  assert.match(source, /reversed-within-groups/u);
  assert.match(source, /mode:\s*0o700/u);
  assert.match(source, /runWithIsolationCleanup/u);
  assert.match(source, /performance\.now/u);
  assert.match(source, /const outputPath = join\(sessionDir, "child\.json"\)/u);
  assert.match(source, /const resultPath = join\(sessionDir, "result\.json"\)/u);
  assert.doesNotMatch(source, /qwen3:8b/u);
  assert.doesNotMatch(source, /eval-recall-quality\.mjs/u);
});

test("top-level failures use a closed code allowlist and never serialize raw errors", () => {
  const raw = new Error("/home/private/raw candidate text");
  raw.stack = "Error: secret\n at /Users/private/eval.mjs:1:1";
  assert.equal(positionBiasFailureCode(raw), "POSITION_BIAS_EVAL_FAILED");
  assert.equal(formatPositionBiasFailure(raw), "POSITION_BIAS_EVAL_FAILED\n");
  assert.equal(positionBiasFailureCode(Object.defineProperty({}, "code", { get: () => { throw raw; } })), "POSITION_BIAS_EVAL_FAILED");
  assert.equal(new Set(FAILURE_CODES).size, FAILURE_CODES.length);
  for (const code of FAILURE_CODES) assert.match(code, /^[A-Z][A-Z0-9_]+$/u);
});
