#!/usr/bin/env node

import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ALLOWLISTED_MODELS,
  DATASET_VERSION,
  RECALL_FRESHNESS_DATASET,
  canonicalJson,
  datasetSha256,
  sha256
} from "./eval-recall-freshness-ablation.mjs";
import { spawnWithTimeout } from "./eval-recall-candidate-pool.mjs";
import { createProductionFixture } from "./eval-recall-production-path.mjs";
import {
  canonicalLoopbackBaseUrl,
  createAuditedLoopbackFetch,
  jsonBytes,
  manifestTree,
  modelInfo,
  nearestRank,
  runtimeSourceProvenance as commonRuntimeSourceProvenance,
  safeName,
  summarizeRerankDecisions,
  writeAtomic
} from "./recall-eval-runtime-common.mjs";

export { ALLOWLISTED_MODELS, canonicalJson, sha256 };
export const ARMS = Object.freeze(["A", "B", "C"]);
export const CHILD_TIMEOUT_MS = 10 * 60_000;
export const PARENT_TIMEOUT_MS = 45 * 60_000;
export const DIAGNOSTICS_ROOT_RELATIVE = ".muse-dev/evals/recall-pair-aware-v1";
export const TOP_K = 3;
export const REFINE_CHUNKS = true;
export const RERANK_MODEL = "qwen3:8b";
export const RESULT_SCHEMA_VERSION = "muse-recall-pair-aware-v1.v2";
export const CHILD_SCHEMA_VERSION = "muse-recall-pair-aware-v1-child.v2";
export const FAILURE_CODES = Object.freeze([
  "CHILD_OUTPUT_INVALID",
  "CHILD_OUTPUT_MISSING",
  "CHILD_TIMEOUT",
  "CHILD_TRIAL_FAILED",
  "INVALID_ARGUMENTS",
  "MODEL_NOT_ALLOWLISTED",
  "NETWORK_ACCOUNTING_MISMATCH",
  "OWNER_STATE_CHANGED",
  "OWNER_STATE_CHECK_FAILED",
  "PAIR_AWARE_EVAL_FAILED",
  "PARENT_TIMEOUT",
  "RERANK_PRELOAD_OR_SELECTOR_FAILED"
]);
export const PRODUCTION_FLOORS = Object.freeze({
  "embeddinggemma": { absent: 20, ordinary: 18 },
  "nomic-embed-text": { absent: 10, ordinary: 17 },
  "nomic-embed-text-v2-moe": { absent: 20, ordinary: 19 },
  "qwen3-embedding:0.6b": { absent: 20, ordinary: 19 }
});
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticsRoot = join(repoRoot, DIAGNOSTICS_ROOT_RELATIVE);
const RUNTIME_SOURCE_PATHS = Object.freeze([
  "packages/recall/dist/index.js",
  "packages/recall/dist/pipeline.js",
  "packages/recall/dist/ask-note-retrieval.js",
  "apps/cli/dist/ask-note-retrieval.js",
  "scripts/eval-recall-pair-aware-v1.mjs",
  "scripts/recall-eval-runtime-common.mjs"
]);

const rate = (passed, total) => Number((passed / total).toFixed(6));
export { nearestRank };

function failure(code) {
  const error = new Error(code);
  Object.defineProperty(error, "code", { enumerable: false, value: code });
  return error;
}

export function pairAwareFailureCode(error) {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && FAILURE_CODES.includes(code) ? code : "PAIR_AWARE_EVAL_FAILED";
  } catch {
    return "PAIR_AWARE_EVAL_FAILED";
  }
}

export function formatPairAwareFailure(error) {
  return `${pairAwareFailureCode(error)}\n`;
}

function scorePrepared(testCase, prepared, sourceForFile) {
  const sources = prepared.scored.map((item) => sourceForFile(item.file));
  if (testCase.category === "absent") {
    const absentAbstain = prepared.verdict === "ambiguous" || prepared.verdict === "none";
    return { absentAbstain, currentTop1: false, ok: absentAbstain, ordinaryTop1: false, pairRecall: false, reasonCode: absentAbstain ? null : "ABSENT_CONFIDENT" };
  }
  if (testCase.category === "ordinary-positive") {
    const ordinaryTop1 = prepared.verdict === "confident" && sources[0] === testCase.expectedSource;
    return { absentAbstain: false, currentTop1: false, ok: ordinaryTop1, ordinaryTop1, pairRecall: false, reasonCode: ordinaryTop1 ? null : prepared.verdict === "confident" ? "WRONG_TOP1" : "NOT_CONFIDENT" };
  }
  const pairRecall = sources.includes(testCase.currentSource) && sources.includes(testCase.staleSource);
  const currentTop1 = sources[0] === testCase.currentSource;
  return { absentAbstain: false, currentTop1, ok: currentTop1, ordinaryTop1: false, pairRecall, reasonCode: currentTop1 ? null : !pairRecall ? "PAIR_MISSING" : sources[0] === testCase.staleSource ? "STALE_TOP1" : "DISTRACTOR_TOP1" };
}

function countedReranker(baseFn) {
  const events = [];
  const fn = Object.assign(async (query, texts) => {
    const started = performance.now();
    let response;
    try { response = await baseFn(query, texts); }
    catch { response = { httpAttempts: 0, outcome: "error" }; }
    const execution = response && typeof response === "object" && !Array.isArray(response) && "outcome" in response
      ? response
      : Array.isArray(response) && response.length > 0
        ? { httpAttempts: 0, order: response, outcome: "success" }
        : { httpAttempts: 0, outcome: "empty" };
    events.push({ decision: { eligible: true, httpAttempts: Number.isSafeInteger(execution.httpAttempts) ? execution.httpAttempts : 0, logicalInvocations: 1, outcome: execution.outcome }, durationMs: performance.now() - started });
    return response;
  }, baseFn.mode ? { mode: baseFn.mode } : {});
  return { events, fn };
}

export async function executePairAwareTrial({ embedFn, indexPath, modelTag, notesDir, prepare, rerankFn, sourceForFile, trial }) {
  const arms = Object.fromEntries(ARMS.map((arm) => [arm, { latencyMs: [], outcomes: [] }]));
  const counted = countedReranker(rerankFn);
  for (let caseIndex = 0; caseIndex < RECALL_FRESHNESS_DATASET.cases.length; caseIndex += 1) {
    const testCase = RECALL_FRESHNESS_DATASET.cases[caseIndex];
    const armOrder = (caseIndex + trial) % 2 === 0 ? ARMS : [...ARMS].reverse();
    for (const arm of armOrder) {
      const callsBefore = counted.events.length;
      const started = performance.now();
      const prepared = await prepare({
        embedFn,
        extras: { refineChunks: REFINE_CHUNKS },
        options: { conflictAwareSelection: arm !== "A", embedModel: modelTag, topK: TOP_K },
        query: testCase.query,
        ...(arm === "C" ? { rerankFn: counted.fn } : {}),
        sources: { notesDir, notesIndexFile: indexPath }
      });
      const elapsed = performance.now() - started;
      const callsAfter = counted.events.length;
      if (callsAfter - callsBefore > 1 || (arm !== "C" && callsAfter !== callsBefore)) throw new Error("RERANK_LOGICAL_CALL_DRIFT");
      const event = callsAfter === callsBefore ? undefined : counted.events[callsBefore];
      const rerankDecision = arm === "C"
        ? event?.decision ?? { eligible: false, httpAttempts: 0, logicalInvocations: 0, outcome: "ineligible-window" }
        : { eligible: false, httpAttempts: 0, logicalInvocations: 0, outcome: "absent" };
      arms[arm].latencyMs.push(elapsed);
      arms[arm].outcomes.push({
        ...scorePrepared(testCase, prepared, sourceForFile),
        arm,
        caseId: testCase.caseId,
        category: testCase.category,
        locale: testCase.locale,
        promptBytes: Buffer.byteLength(prepared.systemPrompt, "utf8"),
        rerankDecision,
        rerankerLatencyMs: event?.durationMs ?? 0
      });
    }
  }
  return { accounting: { caseArmExecutions: RECALL_FRESHNESS_DATASET.cases.length * ARMS.length, generativeAnswerRequests: 0, prepareCalls: RECALL_FRESHNESS_DATASET.cases.length * ARMS.length, toolExecutions: 0 }, arms, modelTag, trial };
}

function qualityView(outcomes) {
  return outcomes.map(({ promptBytes: _promptBytes, rerankerLatencyMs: _rerankerLatencyMs, rerankDecision: _rerankDecision, ...quality }) => quality);
}

function decisionView(outcomes) {
  return outcomes.map(({ caseId, locale, rerankDecision }) => ({ caseId, locale, rerankDecision }));
}

function metricRows(outcomes) {
  const rows = [];
  for (const locale of ["all", "ko", "en"]) {
    const localized = locale === "all" ? outcomes : outcomes.filter((item) => item.locale === locale);
    for (const [category, field] of [["ordinary-positive", "ordinaryTop1"], ["absent", "absentAbstain"], ["correction-pair", "currentTop1"]]) {
      const subset = localized.filter((item) => item.category === category);
      const passed = subset.filter((item) => item[field]).length;
      const metric = { category, locale, passed, rate: rate(passed, subset.length), total: subset.length };
      rows.push(category === "correction-pair"
        ? { ...metric, currentTop1: passed, pairRecall: subset.filter((item) => item.pairRecall).length }
        : metric);
    }
  }
  return rows;
}

function summarizeModel(raw) {
  if (raw.trials?.length !== 2) throw new Error(`${raw.modelTag}: trial count mismatch`);
  const arms = {};
  for (const arm of ARMS) {
    const [first, second] = raw.trials.map((trial) => trial.arms[arm]);
    const qualityHashes = [first, second].map((item) => sha256(jsonBytes(qualityView(item.outcomes))));
    const promptHashes = [first, second].map((item) => sha256(jsonBytes(item.outcomes.map(({ caseId, promptBytes }) => ({ caseId, promptBytes })))));
    const decisionHashes = [first, second].map((item) => sha256(jsonBytes(decisionView(item.outcomes))));
    if (qualityHashes[0] !== qualityHashes[1] || promptHashes[0] !== promptHashes[1] || decisionHashes[0] !== decisionHashes[1]) throw new Error(`${raw.modelTag}/${arm} pass2 hash mismatch`);
    const allOutcomes = raw.trials.flatMap((trial) => trial.arms[arm].outcomes);
    const latencies = raw.trials.flatMap((trial) => trial.arms[arm].latencyMs);
    const rerankerLatencies = allOutcomes.filter((item) => item.rerankDecision.eligible).map((item) => item.rerankerLatencyMs);
    const promptBytes = first.outcomes.map((item) => item.promptBytes);
    arms[arm] = {
      decisionHash: decisionHashes[0],
      latency: { p50Ms: nearestRank(latencies, 0.5), p95Ms: nearestRank(latencies, 0.95), samples: latencies.length },
      metrics: metricRows(first.outcomes),
      prompt: { p50Bytes: nearestRank(promptBytes, 0.5), p95Bytes: nearestRank(promptBytes, 0.95), samples: promptBytes.length },
      promptHash: promptHashes[0],
      qualityHash: qualityHashes[0],
      reranker: summarizeRerankDecisions(allOutcomes),
      rerankerLatency: { p50Ms: nearestRank(rerankerLatencies, 0.5), p95Ms: nearestRank(rerankerLatencies, 0.95), samples: rerankerLatencies.length }
    };
  }
  return {
    arms,
    digest: raw.digest,
    dimension: raw.dimension,
    embeddingAccounting: raw.embeddingAccounting,
    modelTag: raw.modelTag,
    networkAccounting: raw.networkAccounting,
    ollamaVersion: raw.ollamaVersion,
    reranker: raw.reranker,
    resolvedTag: raw.resolvedTag,
    warmup: raw.warmup
  };
}

function allMetric(model, arm, category) {
  return model.arms[arm].metrics.find((metric) => metric.locale === "all" && metric.category === category);
}

function developmentGates(models, ownerState) {
  const modelQuality = models.map((model) => {
    const floor = PRODUCTION_FLOORS[model.modelTag];
    const ordinaryA = allMetric(model, "A", "ordinary-positive").passed;
    const ordinaryC = allMetric(model, "C", "ordinary-positive").passed;
    const absentA = allMetric(model, "A", "absent").passed;
    const absentC = allMetric(model, "C", "absent").passed;
    const correction = allMetric(model, "C", "correction-pair");
    return {
      absent: absentC >= absentA && absentC >= floor.absent,
      correctionCurrent: correction.currentTop1 >= 18,
      correctionPair: correction.pairRecall >= 18,
      modelTag: model.modelTag,
      ordinary: ordinaryC >= ordinaryA && ordinaryC >= floor.ordinary
    };
  });
  const reranker = models.reduce((summary, model) => {
    for (const key of Object.keys(summary)) summary[key] += model.arms.C.reranker[key] ?? 0;
    return summary;
  }, { eligible: 0, empty: 0, error: 0, httpAttempts: 0, invalid: 0, logicalInvocations: 0, success: 0, timeout: 0 });
  const failures = reranker.empty + reranker.error + reranker.invalid + reranker.timeout;
  return {
    latency: models.every((model) => model.arms.C.latency.p95Ms - model.arms.A.latency.p95Ms <= 5_000),
    modelQuality,
    ownerState: ownerState.unchanged && ownerState.beforeSha256 === ownerState.afterSha256,
    prompt: models.every((model) => model.arms.C.prompt.p95Bytes <= 24 * 1024),
    reranker: failures === 0 && reranker.httpAttempts === reranker.logicalInvocations && reranker.logicalInvocations === reranker.eligible && models.every((model) => model.arms.C.rerankerLatency.p95Ms <= 4_000)
  };
}

export function buildPairAwareResult({ models: rawModels, ownerState, runMetadata, runtimeSources }) {
  const models = rawModels.map(summarizeModel);
  const gates = developmentGates(models, ownerState);
  const developmentGatesPassed = models.length === ALLOWLISTED_MODELS.length
    && gates.modelQuality.every(({ modelTag: _modelTag, ...checks }) => Object.values(checks).every(Boolean))
    && gates.latency && gates.ownerState && gates.prompt && gates.reranker;
  const rerankerHttpAttempts = models.reduce((sum, model) => sum + model.arms.C.reranker.httpAttempts, 0);
  const rerankerLogicalInvocations = models.reduce((sum, model) => sum + model.arms.C.reranker.logicalInvocations, 0);
  const embeddingRequests = models.reduce((sum, model) => sum + model.embeddingAccounting.totalRequests, 0);
  const warmupHttpAttempts = models.reduce((sum, model) => sum + model.warmup.httpAttempts, 0);
  const network = models.reduce((summary, model) => {
    for (const key of Object.keys(summary)) summary[key] += model.networkAccounting[key];
    return summary;
  }, {
    answerRequests: 0,
    controlRequests: 0,
    deniedExternalRequests: 0,
    embeddingRequests: 0,
    otherLoopbackRequests: 0,
    preloadRequests: 0,
    selectorRequests: 0,
    totalLoopbackRequests: 0
  });
  const payload = {
    accounting: {
      answerRequests: network.answerRequests,
      caseArmTrialExecutions: models.length * RECALL_FRESHNESS_DATASET.cases.length * ARMS.length * 2,
      collapsedCasesPerModelArm: RECALL_FRESHNESS_DATASET.cases.length,
      deniedExternalRequests: network.deniedExternalRequests,
      externalNetworkRequests: network.deniedExternalRequests,
      generativeAnswerRequests: network.answerRequests,
      localOllamaControlRequests: network.controlRequests,
      localOllamaEmbeddingRequests: embeddingRequests,
      localOllamaRequests: network.totalLoopbackRequests,
      otherLoopbackRequests: network.otherLoopbackRequests,
      prepareCalls: models.length * RECALL_FRESHNESS_DATASET.cases.length * ARMS.length * 2,
      preloadRequests: network.preloadRequests,
      rerankerHttpAttempts,
      rerankerLogicalInvocations,
      selectorRequests: network.selectorRequests,
      toolExecutions: 0,
      warmupHttpAttempts
    },
    arms: { A: { conflictAwareSelection: false, reranker: false }, B: { conflictAwareSelection: true, reranker: false }, C: { conflictAwareSelection: true, reranker: RERANK_MODEL } },
    dataset: {
      cases: 60,
      corpusEntries: 60,
      dataOrigin: "synthetic frozen v1",
      datasetSha256: datasetSha256(),
      datasetVersion: DATASET_VERSION,
      heldOut: false,
      organicEvidence: false
    },
    executionStatus: models.length === ALLOWLISTED_MODELS.length && gates.ownerState ? "COMPLETE" : "INCOMPLETE",
    models,
    ownerState,
    qualification: { developmentGatesPassed, gates, organicEvidence: false, status: "DEVELOPMENT_ONLY" },
    runtimeSources,
    trials: 2
  };
  return { payload, payloadHash: sha256(jsonBytes(payload)), runMetadata, schemaVersion: RESULT_SCHEMA_VERSION };
}

export function validateOwnerState(ownerState) {
  if (typeof ownerState?.beforeSha256 !== "string" || typeof ownerState?.afterSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(ownerState.beforeSha256) || !/^[a-f0-9]{64}$/u.test(ownerState.afterSha256)) throw failure("OWNER_STATE_CHECK_FAILED");
  if (!ownerState.unchanged || ownerState.beforeSha256 !== ownerState.afterSha256) throw failure("OWNER_STATE_CHANGED");
  return ownerState;
}

export function validatePairAwareResult(result) {
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION || result.payloadHash !== sha256(jsonBytes(result.payload))) throw new Error("canonical result hash/version mismatch");
  const { accounting, arms, dataset, executionStatus, models, ownerState, qualification, runtimeSources, trials } = result.payload;
  if (dataset.cases !== 60 || dataset.corpusEntries !== 60 || dataset.dataOrigin !== "synthetic frozen v1" || dataset.datasetVersion !== DATASET_VERSION || dataset.datasetSha256 !== datasetSha256() || dataset.heldOut !== false || dataset.organicEvidence !== false) throw new Error("dataset provenance mismatch");
  if (executionStatus !== "COMPLETE" || trials !== 2 || canonicalJson(arms) !== canonicalJson({ A: { conflictAwareSelection: false, reranker: false }, B: { conflictAwareSelection: true, reranker: false }, C: { conflictAwareSelection: true, reranker: RERANK_MODEL } })) throw new Error("execution contract mismatch");
  if (models.length !== 4 || canonicalJson(models.map((model) => model.modelTag)) !== canonicalJson(ALLOWLISTED_MODELS)) throw new Error("model allowlist mismatch");
  if (accounting.caseArmTrialExecutions !== 1_440 || accounting.prepareCalls !== 1_440 || accounting.collapsedCasesPerModelArm !== 60 || accounting.generativeAnswerRequests !== 0 || accounting.answerRequests !== 0 || accounting.toolExecutions !== 0 || accounting.externalNetworkRequests !== 0 || accounting.deniedExternalRequests !== 0 || accounting.otherLoopbackRequests !== 0 || accounting.rerankerLogicalInvocations > 480 || accounting.rerankerHttpAttempts > 480) throw new Error("accounting mismatch");
  if (accounting.selectorRequests !== accounting.rerankerHttpAttempts + accounting.warmupHttpAttempts) throw new Error("selector accounting mismatch");
  if (accounting.preloadRequests !== models.length || accounting.localOllamaEmbeddingRequests !== models.reduce((sum, model) => sum + model.networkAccounting.embeddingRequests, 0)) throw new Error("observed request accounting mismatch");
  if (accounting.localOllamaRequests !== accounting.localOllamaEmbeddingRequests + accounting.selectorRequests + accounting.preloadRequests + accounting.localOllamaControlRequests + accounting.answerRequests + accounting.otherLoopbackRequests) throw new Error("local Ollama accounting mismatch");
  validateOwnerState(ownerState);
  for (const model of models) {
    if (model.reranker?.modelTag !== RERANK_MODEL || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(model.reranker.digest) || !model.reranker.resolvedTag) throw new Error("reranker provenance mismatch");
    if (!model.warmup?.afterIndex || model.warmup.embeddingRequests !== 1 || model.warmup.httpAttempts !== 1 || model.warmup.outcome !== "success" || model.warmup.preloadRequests !== 1 || model.warmup.selectorRequests !== 1) throw new Error("warmup provenance mismatch");
    validateObservedNetworkAccounting(model.networkAccounting, {
      controlRequests: 4,
      embeddingRequests: model.embeddingAccounting.totalRequests,
      preloadRequests: model.warmup.preloadRequests,
      selectorRequests: model.warmup.selectorRequests + model.arms.C.reranker.httpAttempts
    });
    for (const arm of ARMS) {
      const metrics = model.arms[arm].metrics;
      const all = metrics.filter((metric) => metric.locale === "all");
      const localized = metrics.filter((metric) => metric.locale !== "all");
      if (all.length !== 3 || all.some((metric) => metric.total !== 20) || localized.length !== 6 || localized.some((metric) => metric.total !== 10)) throw new Error("quality denominator mismatch");
      if (model.arms[arm].latency.samples !== 120 || model.arms[arm].prompt.samples !== 60) throw new Error("sample denominator mismatch");
    }
  }
  const expectedGates = developmentGates(models, ownerState);
  const expectedPassed = expectedGates.modelQuality.every(({ modelTag: _modelTag, ...checks }) => Object.values(checks).every(Boolean)) && expectedGates.latency && expectedGates.ownerState && expectedGates.prompt && expectedGates.reranker;
  if (qualification.status !== "DEVELOPMENT_ONLY" || qualification.organicEvidence !== false || qualification.developmentGatesPassed !== expectedPassed || canonicalJson(qualification.gates) !== canonicalJson(expectedGates)) throw new Error("qualification mismatch");
  for (const source of runtimeSources) if (!source || typeof source.path !== "string" || !/^[a-f0-9]{64}$/u.test(source.sha256)) throw new Error("runtime source mismatch");
  if (/\/Users\/|\/home\/|\.muse\/|promptText|rawPrompt/iu.test(canonicalJson(result))) throw new Error("private/raw field in result");
  return result;
}

function childEnv(baseUrl, home) {
  return {
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    MUSE_CLI_CONFIG_FILE: join(home, "config.json"),
    MUSE_LOCAL_ONLY: "true",
    MUSE_MODEL_KEYS_FILE: join(home, "models.json"),
    MUSE_RECALL_RERANK: RERANK_MODEL,
    OLLAMA_BASE_URL: baseUrl,
    PATH: process.env.PATH ?? "",
    TMPDIR: join(home, "tmp")
  };
}

const NETWORK_ACCOUNTING_KEYS = Object.freeze([
  "answerRequests",
  "controlRequests",
  "deniedExternalRequests",
  "embeddingRequests",
  "otherLoopbackRequests",
  "preloadRequests",
  "selectorRequests",
  "totalLoopbackRequests"
]);

export function validateObservedNetworkAccounting(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...NETWORK_ACCOUNTING_KEYS].sort())) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  if (NETWORK_ACCOUNTING_KEYS.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  const summedLoopback = value.answerRequests
    + value.controlRequests
    + value.embeddingRequests
    + value.otherLoopbackRequests
    + value.preloadRequests
    + value.selectorRequests;
  if (value.totalLoopbackRequests !== summedLoopback
    || value.answerRequests !== 0
    || value.deniedExternalRequests !== 0
    || value.otherLoopbackRequests !== 0
    || value.controlRequests !== expected.controlRequests
    || value.embeddingRequests !== expected.embeddingRequests
    || value.preloadRequests !== expected.preloadRequests
    || value.selectorRequests !== expected.selectorRequests) {
    throw failure("NETWORK_ACCOUNTING_MISMATCH");
  }
  return value;
}

function validateChildModel(value, modelTag) {
  if (value.schemaVersion !== CHILD_SCHEMA_VERSION || value.modelTag !== modelTag || value.trials?.length !== 2) throw new Error(`${modelTag}: child identity mismatch`);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.digest) || !Number.isInteger(value.dimension) || value.dimension <= 0 || !value.resolvedTag || !value.ollamaVersion) throw new Error(`${modelTag}: model provenance mismatch`);
  if (!value.reranker || value.reranker.modelTag !== RERANK_MODEL || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.reranker.digest)) throw new Error(`${modelTag}: reranker provenance mismatch`);
  if (!value.warmup?.afterIndex || value.warmup.embeddingRequests !== 1 || value.warmup.httpAttempts !== 1 || value.warmup.outcome !== "success" || value.warmup.preloadRequests !== 1 || value.warmup.selectorRequests !== 1) throw new Error(`${modelTag}: warmup mismatch`);
  if (!Number.isInteger(value.embeddingAccounting?.indexRequests) || value.embeddingAccounting.indexRequests < 60 || !Number.isInteger(value.embeddingAccounting.measuredRequests) || value.embeddingAccounting.measuredRequests < 360 || value.embeddingAccounting.warmupRequests !== 1 || value.embeddingAccounting.totalRequests !== value.embeddingAccounting.indexRequests + value.embeddingAccounting.measuredRequests + value.embeddingAccounting.warmupRequests) throw new Error(`${modelTag}: embedding accounting mismatch`);
  let trialSelectorRequests = 0;
  for (let trialIndex = 0; trialIndex < 2; trialIndex += 1) {
    const trial = value.trials[trialIndex];
    if (trial.modelTag !== modelTag || trial.trial !== trialIndex + 1 || canonicalJson(trial.accounting) !== canonicalJson({ caseArmExecutions: 180, generativeAnswerRequests: 0, prepareCalls: 180, toolExecutions: 0 })) throw new Error(`${modelTag}: trial accounting mismatch`);
    for (const arm of ARMS) {
      const measured = trial.arms?.[arm];
      if (measured?.outcomes?.length !== 60 || measured.latencyMs?.length !== 60) throw new Error(`${modelTag}/${arm}: trial denominator mismatch`);
      for (let caseIndex = 0; caseIndex < measured.outcomes.length; caseIndex += 1) {
        const outcome = measured.outcomes[caseIndex];
        const testCase = RECALL_FRESHNESS_DATASET.cases[caseIndex];
        const decision = outcome.rerankDecision;
        if (outcome.caseId !== testCase.caseId || outcome.category !== testCase.category || outcome.arm !== arm || outcome.locale !== testCase.locale || !Number.isInteger(outcome.promptBytes) || outcome.promptBytes <= 0) throw new Error(`${modelTag}/${arm}: outcome identity mismatch`);
        if (![0, 1].includes(decision.logicalInvocations) || !Number.isInteger(decision.httpAttempts) || decision.httpAttempts < 0 || decision.httpAttempts > 1) throw new Error(`${modelTag}/${arm}: reranker call bound mismatch`);
        if (arm !== "C" && (decision.eligible || decision.logicalInvocations !== 0 || decision.httpAttempts !== 0 || decision.outcome !== "absent")) throw new Error(`${modelTag}/${arm}: reranker isolation mismatch`);
        if (arm === "C") {
          if (decision.logicalInvocations !== (decision.eligible ? 1 : 0)) throw new Error(`${modelTag}/${arm}: reranker eligibility mismatch`);
          trialSelectorRequests += decision.httpAttempts;
        }
      }
    }
  }
  validateObservedNetworkAccounting(value.networkAccounting, {
    controlRequests: 4,
    embeddingRequests: value.embeddingAccounting.totalRequests,
    preloadRequests: value.warmup.preloadRequests,
    selectorRequests: value.warmup.selectorRequests + trialSelectorRequests
  });
  return value;
}

async function childModel({ baseUrl, home, modelTag, outputPath }) {
  const [{ loadIndex }, { embed: cliEmbed }, { retrieveAndRankNotes }] = await Promise.all([
    import("../packages/recall/dist/index.js"),
    import("../apps/cli/dist/embed.js"),
    import("../apps/cli/dist/ask-note-retrieval.js")
  ]);
  if (!home || !process.env.TMPDIR?.startsWith(home)) throw new Error("child HOME/TMPDIR isolation missing");
  const runtimeEnv = Object.freeze(childEnv(baseUrl, home));
  const audit = createAuditedLoopbackFetch(baseUrl);
  const embed = (text, model = modelTag) => cliEmbed(text, model, { fetchImpl: audit.fetch }, runtimeEnv);
  const [embedInfo, rerankerInfo] = await Promise.all([
    modelInfo(baseUrl, modelTag, audit.fetch),
    modelInfo(baseUrl, RERANK_MODEL, audit.fetch)
  ]);
  const fixture = await createProductionFixture({ embed, home, modelTag });
  const afterIndex = audit.snapshot();
  const index = await loadIndex(fixture.indexPath);
  const warmupCase = RECALL_FRESHNESS_DATASET.cases.find((testCase) => testCase.category === "correction-pair");
  if (!index || !warmupCase) throw new Error("PAIR_AWARE_EVAL_FAILED");
  const warmupResult = await retrieveAndRankNotes({
    conflictAwareSelection: true,
    embedModel: modelTag,
    indexFiles: index.files,
    json: true,
    notesDir: fixture.notesDir,
    onStderr: () => {},
    query: warmupCase.query,
    scope: undefined,
    snapshotIdentity: { indexBuiltAtIso: index.builtAtIso, notesIndexFile: fixture.indexPath },
    topK: TOP_K
  }, { env: runtimeEnv, fetchFn: audit.fetch });
  const afterWarmup = audit.snapshot();
  const warmup = {
    afterIndex: true,
    embeddingRequests: afterWarmup.embeddingRequests - afterIndex.embeddingRequests,
    httpAttempts: afterWarmup.selectorRequests - afterIndex.selectorRequests,
    outcome: warmupResult.rerankDecision?.outcome,
    preloadRequests: afterWarmup.preloadRequests - afterIndex.preloadRequests,
    selectorRequests: afterWarmup.selectorRequests - afterIndex.selectorRequests
  };
  const rerankFn = warmupResult.snapshot?.rerankFn;
  if (!rerankFn || warmupResult.notesUnavailable || warmup.outcome !== "success" || warmup.httpAttempts !== 1 || warmup.preloadRequests !== 1 || warmup.selectorRequests !== 1 || warmup.embeddingRequests !== 1) {
    throw failure("RERANK_PRELOAD_OR_SELECTOR_FAILED");
  }
  const trials = [];
  for (let trial = 1; trial <= 2; trial += 1) {
    trials.push(await executePairAwareTrial({ embedFn: embed, indexPath: fixture.indexPath, modelTag, notesDir: fixture.notesDir, prepare: fixture.prepare, rerankFn, sourceForFile: fixture.sourceForFile, trial }));
  }
  const networkAccounting = audit.snapshot();
  const value = {
    ...embedInfo,
    dimension: fixture.index.embeddingDimension,
    embeddingAccounting: {
      indexRequests: afterIndex.embeddingRequests,
      measuredRequests: networkAccounting.embeddingRequests - afterWarmup.embeddingRequests,
      totalRequests: networkAccounting.embeddingRequests,
      warmupRequests: warmup.embeddingRequests
    },
    modelTag,
    networkAccounting,
    reranker: { ...rerankerInfo, modelTag: RERANK_MODEL },
    schemaVersion: CHILD_SCHEMA_VERSION,
    trials,
    warmup
  };
  validateChildModel(value, modelTag);
  await writeAtomic(outputPath, jsonBytes(value));
}

function parseInternalArgs(args) {
  const out = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("malformed internal options");
    out[args[index].slice(2)] = args[index + 1];
  }
  return out;
}

export function normalizeCliArgs(args) { return args.filter((item) => item !== "--"); }

/**
 * Runs an evaluation body while guaranteeing a second owner-state capture.
 * The after manifest is collected in `finally`, including body failures and
 * timeouts surfaced by a child. Owner drift/check failure takes precedence so
 * a failed eval can never hide a mutation of the user's real Muse state.
 */
export async function runWithOwnerStateGuard({ afterPath, beforePath, capture = manifestTree, ownerRoot, run, write = writeAtomic }) {
  let after;
  let before;
  let operationError;
  let ownerState;
  let value;
  try {
    before = await capture(ownerRoot);
    await write(beforePath, jsonBytes(before));
    value = await run();
  } catch (error) {
    operationError = error;
  } finally {
    if (before) {
      try {
        after = await capture(ownerRoot);
        await write(afterPath, jsonBytes(after));
        ownerState = validateOwnerState({
          afterSha256: after.manifestSha256,
          beforeSha256: before.manifestSha256,
          unchanged: before.manifestSha256 === after.manifestSha256
        });
      } catch (error) {
        operationError = pairAwareFailureCode(error) === "OWNER_STATE_CHANGED"
          ? error
          : failure("OWNER_STATE_CHECK_FAILED");
      }
    } else {
      operationError = failure("OWNER_STATE_CHECK_FAILED");
    }
  }
  if (operationError) throw operationError;
  return { ownerState, value };
}

function childFailure(reasonCode) {
  if (reasonCode === "TIMEOUT") return failure("CHILD_TIMEOUT");
  if (reasonCode === "PARTIAL_OUTPUT") return failure("CHILD_OUTPUT_MISSING");
  return failure("CHILD_TRIAL_FAILED");
}

async function parentMain(smokeModel) {
  const { detectStaleMarker } = await import("../packages/recall/dist/index.js");
  const { validateDataset } = await import("./eval-recall-freshness-ablation.mjs");
  validateDataset(RECALL_FRESHNESS_DATASET, detectStaleMarker);
  const requestedModels = smokeModel ? [smokeModel] : [...ALLOWLISTED_MODELS];
  if (requestedModels.some((model) => !ALLOWLISTED_MODELS.includes(model))) throw failure("MODEL_NOT_ALLOWLISTED");
  const started = Date.now();
  const sessionDir = join(diagnosticsRoot, new Date().toISOString().replaceAll(/[:.]/gu, "-"));
  await mkdir(sessionDir, { mode: 0o700, recursive: true });
  const ownerRoot = join(homedir(), ".muse");
  const baseUrl = canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434");
  const guarded = await runWithOwnerStateGuard({
    afterPath: join(sessionDir, "owner-after.json"),
    beforePath: join(sessionDir, "owner-before.json"),
    ownerRoot,
    run: async () => {
      const models = [];
      for (const modelTag of requestedModels) {
        const remaining = PARENT_TIMEOUT_MS - (Date.now() - started);
        if (remaining <= 0) throw failure("PARENT_TIMEOUT");
        const home = join(sessionDir, "homes", safeName(modelTag));
        await mkdir(join(home, "tmp"), { mode: 0o700, recursive: true });
        const outputPath = join(sessionDir, `${safeName(modelTag)}.json`);
        const child = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child", "1", "--model", modelTag, "--out", outputPath, "--home", home], { env: childEnv(baseUrl, home), outputPath, timeoutMs: Math.min(CHILD_TIMEOUT_MS, remaining) });
        if (!child.ok) throw childFailure(child.reasonCode);
        try {
          models.push(validateChildModel(JSON.parse(await readFile(outputPath, "utf8")), modelTag));
        } catch {
          throw failure("CHILD_OUTPUT_INVALID");
        }
      }
      if (Date.now() - started >= PARENT_TIMEOUT_MS) throw failure("PARENT_TIMEOUT");
      return models;
    }
  });
  if (Date.now() - started >= PARENT_TIMEOUT_MS) throw failure("PARENT_TIMEOUT");
  const models = guarded.value;
  const ownerState = guarded.ownerState;
  if (smokeModel) {
    const model = summarizeModel(models[0]);
    process.stdout.write(`${canonicalJson({ arms: model.arms, model: smokeModel, networkAccounting: model.networkAccounting, qualification: "DEVELOPMENT_ONLY", schemaVersion: RESULT_SCHEMA_VERSION, status: "SMOKE_PASS", trials: 2 })}\n`);
    return;
  }
  const result = buildPairAwareResult({
    models,
    ownerState,
    runMetadata: { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}` },
    runtimeSources: await commonRuntimeSourceProvenance(repoRoot, RUNTIME_SOURCE_PATHS)
  });
  validatePairAwareResult(result);
  await writeAtomic(join(sessionDir, "result.json"), jsonBytes(result));
  process.stdout.write(`${canonicalJson({ artifact: join(DIAGNOSTICS_ROOT_RELATIVE, sessionDir.slice(diagnosticsRoot.length + 1), "result.json"), developmentGatesPassed: result.payload.qualification.developmentGatesPassed, status: result.payload.executionStatus })}\n`);
}

async function main() {
  const args = normalizeCliArgs(process.argv.slice(2));
  if (args[0] === "--child") {
    const options = parseInternalArgs(args.slice(2));
    if (!options.model || !options.out || !options.home) throw failure("INVALID_ARGUMENTS");
    if (!ALLOWLISTED_MODELS.includes(options.model)) throw failure("MODEL_NOT_ALLOWLISTED");
    await childModel({ baseUrl: canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL), home: options.home, modelTag: options.model, outputPath: options.out });
    return;
  }
  if (args.length === 0) return parentMain();
  if (args.length === 2 && args[0] === "--smoke-model") return parentMain(args[1]);
  throw failure("INVALID_ARGUMENTS");
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) main().catch((error) => { process.stderr.write(formatPairAwareFailure(error)); process.exitCode = 1; });
