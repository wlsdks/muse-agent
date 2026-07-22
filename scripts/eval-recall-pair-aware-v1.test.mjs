import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ALLOWLISTED_MODELS, RECALL_FRESHNESS_DATASET } from "./eval-recall-freshness-ablation.mjs";
import {
  ARMS,
  CHILD_TIMEOUT_MS,
  DIAGNOSTICS_ROOT_RELATIVE,
  FAILURE_CODES,
  PARENT_TIMEOUT_MS,
  RESULT_SCHEMA_VERSION,
  buildPairAwareResult,
  canonicalJson,
  executePairAwareTrial,
  formatPairAwareFailure,
  normalizeCliArgs,
  pairAwareFailureCode,
  runWithOwnerStateGuard,
  sha256,
  validateObservedNetworkAccounting,
  validateOwnerState,
  validatePairAwareResult
} from "./eval-recall-pair-aware-v1.mjs";

const scored = (...sources) => ({ scored: sources.map((file) => ({ file })), systemPrompt: "prompt", verdict: "confident" });

test("one trial measures frozen v1 through distinct A baseline, B conflict-only, and C pair-aware arms", async () => {
  const byQuery = new Map(RECALL_FRESHNESS_DATASET.cases.map((item) => [item.query, item]));
  const calls = [];
  const trial = await executePairAwareTrial({
    embedFn: async () => [1],
    indexPath: "/tmp/eval/notes-index.json",
    modelTag: ALLOWLISTED_MODELS[0],
    notesDir: "/tmp/eval/notes",
    prepare: async (input) => {
      calls.push(input);
      if (input.rerankFn) await input.rerankFn(input.query, ["old", "current"]);
      const item = byQuery.get(input.query);
      if (item.category === "absent") return { scored: [], systemPrompt: "prompt", verdict: "none" };
      if (item.category === "correction-pair") return scored(item.currentSource, item.staleSource);
      return scored(item.expectedSource);
    },
    rerankFn: Object.assign(async () => ({ httpAttempts: 1, order: [0, 1], outcome: "success", pairHints: [{ current: 0, stale: 1 }] }), { mode: "correction-pair" }),
    sourceForFile: (file) => file,
    trial: 1
  });

  assert.deepEqual(ARMS, ["A", "B", "C"]);
  assert.equal(calls.length, 180);
  assert.equal(calls.filter((input) => input.options.conflictAwareSelection === false && !input.rerankFn).length, 60);
  assert.equal(calls.filter((input) => input.options.conflictAwareSelection === true && !input.rerankFn).length, 60);
  assert.equal(calls.filter((input) => input.options.conflictAwareSelection === true && typeof input.rerankFn === "function").length, 60);
  assert.equal(calls.filter((input) => input.rerankFn?.mode === "correction-pair").length, 60);
  assert.ok(calls.every((input) => input.options.topK === 3 && input.extras.refineChunks === true));
  assert.deepEqual(trial.accounting, { caseArmExecutions: 180, generativeAnswerRequests: 0, prepareCalls: 180, toolExecutions: 0 });
  assert.equal(trial.arms.A.outcomes.length, 60);
  assert.equal(trial.arms.B.outcomes.length, 60);
  assert.equal(trial.arms.C.outcomes.length, 60);
  assert.equal(trial.arms.C.outcomes.every((item) => item.rerankDecision.logicalInvocations === 1), true);
});

test("runner is DEVELOPMENT_ONLY, isolated, explicitly bounded, and has no canonical promotion surface", () => {
  assert.equal(CHILD_TIMEOUT_MS, 10 * 60_000);
  assert.equal(PARENT_TIMEOUT_MS, 45 * 60_000);
  assert.equal(DIAGNOSTICS_ROOT_RELATIVE, ".muse-dev/evals/recall-pair-aware-v1");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const source = readFileSync(new URL("./eval-recall-pair-aware-v1.mjs", import.meta.url), "utf8");
  assert.match(packageJson.scripts["eval:recall-pair-aware-v1"], /eval-recall-pair-aware-v1\.mjs/u);
  assert.match(packageJson.scripts["test:recall-pair-aware-v1"], /eval-recall-pair-aware-v1\.test\.mjs/u);
  assert.deepEqual(normalizeCliArgs(["--", "--smoke-model", ALLOWLISTED_MODELS[0]]), ["--smoke-model", ALLOWLISTED_MODELS[0]]);
  assert.match(source, /--smoke-model/u);
  assert.equal(RESULT_SCHEMA_VERSION, "muse-recall-pair-aware-v1.v2");
  assert.match(source, /createAuditedLoopbackFetch/u);
  assert.match(source, /modelInfo\(baseUrl, modelTag, audit\.fetch\)/u);
  assert.match(source, /fetchImpl: audit\.fetch/u);
  assert.match(source, /fetchFn: audit\.fetch/u);
  assert.doesNotMatch(source, /networkAccounting:\s*\{\s*externalRequests:\s*0/iu);
  assert.doesNotMatch(source, /error\?\.stack|error\.stack/iu);
  assert.doesNotMatch(source, /docs\/benchmarks|README|promoteTracked|renderSvg|renderMarkdown/iu);
});

test("smoke owner-state contract fails closed on manifest drift", () => {
  const digest = "d".repeat(64);
  assert.deepEqual(validateOwnerState({ afterSha256: digest, beforeSha256: digest, unchanged: true }), { afterSha256: digest, beforeSha256: digest, unchanged: true });
  assert.throws(() => validateOwnerState({ afterSha256: "a".repeat(64), beforeSha256: "b".repeat(64), unchanged: false }), /OWNER_STATE_CHANGED/);
  assert.throws(() => validateOwnerState({ afterSha256: undefined, beforeSha256: undefined, unchanged: true }), /OWNER_STATE_CHECK_FAILED/);
});

test("owner after-manifest executes in finally even when the evaluation body fails", async () => {
  const digest = "d".repeat(64);
  const captures = [];
  let thrown;
  try {
    await runWithOwnerStateGuard({
      afterPath: "/isolated/owner-after.json",
      beforePath: "/isolated/owner-before.json",
      capture: async (root) => { captures.push(root); return { entries: [], manifestSha256: digest }; },
      ownerRoot: "/owner/.muse",
      run: async () => { throw new Error("/Users/private/raw prompt must never escape"); },
      write: async () => {}
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(captures.length, 2);
  assert.equal(pairAwareFailureCode(thrown), "PAIR_AWARE_EVAL_FAILED");
  assert.equal(formatPairAwareFailure(thrown), "PAIR_AWARE_EVAL_FAILED\n");
  assert.doesNotMatch(formatPairAwareFailure(thrown), /Users|private|prompt|at\s/iu);
});

test("owner drift found in finally takes precedence over a child failure", async () => {
  const manifests = ["a".repeat(64), "b".repeat(64)];
  let thrown;
  try {
    await runWithOwnerStateGuard({
      afterPath: "/isolated/owner-after.json",
      beforePath: "/isolated/owner-before.json",
      capture: async () => ({ entries: [], manifestSha256: manifests.shift() }),
      ownerRoot: "/owner/.muse",
      run: async () => { throw new Error("child failed"); },
      write: async () => {}
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(formatPairAwareFailure(thrown), "OWNER_STATE_CHANGED\n");
  assert.equal(manifests.length, 0);
});

test("top-level failure formatting is a closed allowlist and never serializes raw errors", () => {
  const raw = new Error("/home/private notes and raw candidate text");
  raw.stack = "Error: secret\n at /Users/private/eval.mjs:1:1";
  assert.equal(formatPairAwareFailure(raw), "PAIR_AWARE_EVAL_FAILED\n");
  assert.equal(formatPairAwareFailure(Object.defineProperty({}, "code", { get: () => { throw raw; } })), "PAIR_AWARE_EVAL_FAILED\n");
  for (const code of FAILURE_CODES) assert.match(code, /^[A-Z][A-Z0-9_]+$/u);
  assert.equal(new Set(FAILURE_CODES).size, FAILURE_CODES.length);
});

function completeOutcomes(arm) {
  return RECALL_FRESHNESS_DATASET.cases.map((item) => ({
    absentAbstain: item.category === "absent",
    arm,
    caseId: item.caseId,
    category: item.category,
    currentTop1: item.category === "correction-pair",
    locale: item.locale,
    ok: true,
    ordinaryTop1: item.category === "ordinary-positive",
    pairRecall: item.category === "correction-pair",
    promptBytes: 1000,
    reasonCode: null,
    rerankDecision: arm === "C"
      ? { eligible: true, httpAttempts: 1, logicalInvocations: 1, outcome: "success" }
      : { eligible: false, httpAttempts: 0, logicalInvocations: 0, outcome: "absent" },
    rerankerLatencyMs: arm === "C" ? 100 : 0
  }));
}

function completeRawModel(modelTag, modelIndex) {
  return {
    digest: String(modelIndex + 1).repeat(64).slice(0, 64),
    dimension: 768,
    embeddingAccounting: { indexRequests: 60, measuredRequests: 360, totalRequests: 421, warmupRequests: 1 },
    modelTag,
    networkAccounting: {
      answerRequests: 0,
      controlRequests: 4,
      deniedExternalRequests: 0,
      embeddingRequests: 421,
      otherLoopbackRequests: 0,
      preloadRequests: 1,
      selectorRequests: 121,
      totalLoopbackRequests: 547
    },
    ollamaVersion: "0.32.0",
    reranker: { digest: "a".repeat(64), modelTag: "qwen3:8b", resolvedTag: "qwen3:8b" },
    resolvedTag: modelTag,
    trials: [1, 2].map((trial) => ({
      accounting: { caseArmExecutions: 180, generativeAnswerRequests: 0, prepareCalls: 180, toolExecutions: 0 },
      arms: Object.fromEntries(ARMS.map((arm) => [arm, { latencyMs: Array(60).fill(arm === "C" ? 200 : 10), outcomes: completeOutcomes(arm) }])),
      modelTag,
      trial
    })),
    warmup: { afterIndex: true, embeddingRequests: 1, httpAttempts: 1, outcome: "success", preloadRequests: 1, selectorRequests: 1 }
  };
}

test("two trials collapse to per-model 20-case quality while accounting all three arms exactly", () => {
  const models = ALLOWLISTED_MODELS.map(completeRawModel);
  const result = buildPairAwareResult({
    models,
    ownerState: { afterSha256: "b".repeat(64), beforeSha256: "b".repeat(64), unchanged: true },
    runMetadata: { generatedAt: "2030-01-01T00:00:00.000Z", node: "v24", platform: "darwin/arm64" },
    runtimeSources: [{ path: "packages/recall/dist/index.js", sha256: "c".repeat(64) }]
  });

  assert.equal(validatePairAwareResult(result), result);
  assert.equal(result.payload.qualification.status, "DEVELOPMENT_ONLY");
  assert.equal(result.payload.dataset.heldOut, false);
  assert.equal(result.payload.dataset.organicEvidence, false);
  assert.equal(result.payload.accounting.caseArmTrialExecutions, 1_440);
  assert.equal(result.payload.accounting.collapsedCasesPerModelArm, 60);
  assert.equal(result.payload.accounting.preloadRequests, 4);
  assert.equal(result.payload.accounting.selectorRequests, 484);
  assert.equal(result.payload.accounting.localOllamaEmbeddingRequests, 1_684);
  assert.equal(result.payload.accounting.localOllamaControlRequests, 16);
  assert.equal(result.payload.accounting.localOllamaRequests, 2_188);
  assert.equal(result.payload.accounting.answerRequests, 0);
  assert.equal(result.payload.accounting.deniedExternalRequests, 0);
  for (const model of result.payload.models) {
    assert.deepEqual(model.reranker, { digest: "a".repeat(64), modelTag: "qwen3:8b", resolvedTag: "qwen3:8b" });
    for (const arm of ARMS) {
      const all = model.arms[arm].metrics.filter((metric) => metric.locale === "all");
      assert.deepEqual(all.map(({ category, total }) => ({ category, total })), [
        { category: "ordinary-positive", total: 20 },
        { category: "absent", total: 20 },
        { category: "correction-pair", total: 20 }
      ]);
    }
  }
  assert.equal(result.payload.qualification.developmentGatesPassed, true);

  const drifted = structuredClone(models);
  drifted[0].trials[1].arms.C.outcomes[0].ok = false;
  assert.throws(() => buildPairAwareResult({ models: drifted, ownerState: result.payload.ownerState, runMetadata: result.runMetadata, runtimeSources: result.payload.runtimeSources }), /pass2 hash mismatch/);

  const forged = structuredClone(result);
  forged.payload.dataset.heldOut = true;
  forged.payloadHash = sha256(`${canonicalJson(forged.payload)}\n`);
  assert.throws(() => validatePairAwareResult(forged), /dataset provenance/);

  const selfReported = structuredClone(result);
  selfReported.payload.models[0].networkAccounting.selectorRequests -= 1;
  selfReported.payload.models[0].networkAccounting.totalLoopbackRequests -= 1;
  selfReported.payloadHash = sha256(`${canonicalJson(selfReported.payload)}\n`);
  assert.throws(() => validatePairAwareResult(selfReported), /NETWORK_ACCOUNTING_MISMATCH/);
});

test("observed network accounting rejects answer-like, external, unknown, and arithmetic mutations", () => {
  const expected = { controlRequests: 4, embeddingRequests: 421, preloadRequests: 1, selectorRequests: 121 };
  const observed = completeRawModel(ALLOWLISTED_MODELS[0], 0).networkAccounting;
  assert.equal(validateObservedNetworkAccounting(observed, expected), observed);
  for (const key of ["answerRequests", "deniedExternalRequests", "otherLoopbackRequests"]) {
    const mutated = { ...observed, [key]: 1 };
    if (key !== "deniedExternalRequests") mutated.totalLoopbackRequests += 1;
    assert.throws(() => validateObservedNetworkAccounting(mutated, expected), /NETWORK_ACCOUNTING_MISMATCH/);
  }
  assert.throws(() => validateObservedNetworkAccounting({ ...observed, prompt: "secret" }, expected), /NETWORK_ACCOUNTING_MISMATCH/);
  assert.throws(() => validateObservedNetworkAccounting({ ...observed, totalLoopbackRequests: observed.totalLoopbackRequests + 1 }, expected), /NETWORK_ACCOUNTING_MISMATCH/);
});
