#!/usr/bin/env node

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spawnWithTimeout } from "./eval-recall-candidate-pool.mjs";
import { RECALL_FRESHNESS_DATASET } from "./eval-recall-freshness-ablation.mjs";
import {
  canonicalJson,
  canonicalLoopbackBaseUrl,
  jsonBytes,
  manifestTree,
  modelInfo,
  nearestRank,
  runtimeSourceProvenance as commonRuntimeSourceProvenance,
  safeName,
  sha256,
  summarizeRerankDecisions,
  writeAtomic
} from "./recall-eval-runtime-common.mjs";
import {
  BURNED_V4_REPLAY_DATASET,
  SOURCE_FREEZE_COMMIT,
  validateBurnedV4ReplayDataset
} from "./replay-recall-conflict-aware-p0-burned-v4-dataset.mjs";

export const ALLOWLISTED_MODELS = Object.freeze(["nomic-embed-text", "nomic-embed-text-v2-moe", "embeddinggemma", "qwen3-embedding:0.6b"]);
export const ARMS = Object.freeze(["A", "B"]);
export const PARENT_TIMEOUT_MS = 25 * 60_000;
export const CHILD_TIMEOUT_MS = 6 * 60_000;
export const RERANK_TIMEOUT_MS = 4_000;
export { SOURCE_FREEZE_COMMIT };
export const RESULT_SCHEMA_VERSION = "muse-recall-conflict-aware-p0-burned-v4-replay.v1";
export const CHILD_SCHEMA_VERSION = "muse-recall-conflict-aware-p0-burned-v4-replay-child.v1";
export const DIAGNOSTICS_ROOT_RELATIVE = ".muse-dev/evals/recall-conflict-aware-p0-burned-v4-replay";
export { canonicalJson, nearestRank, sha256 };
const TOP_K = 3;
const RERANK_MODEL = "qwen3:8b";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticsRoot = join(repoRoot, DIAGNOSTICS_ROOT_RELATIVE);
const runtimePaths = Object.freeze(["packages/recall/dist/pipeline.js", "packages/recall/dist/ask-note-retrieval.js", "packages/recall/dist/notes-index.js", "apps/cli/dist/ask-note-retrieval.js"]);

function rate(passed, total) { return Number((passed / total).toFixed(6)); }
function sourceFilename(source) { return `${source.replaceAll(/[^a-z0-9.-]/giu, "__")}.md`; }
function marker(text) { return /used to|no longer|이전에|지금은 아니/iu.test(text); }

export function scorePrepared(testCase, prepared, sourceForFile) {
  const sources = prepared.scored.map((item) => sourceForFile(item.file));
  if (testCase.category === "absent") { const ok = prepared.verdict === "ambiguous" || prepared.verdict === "none"; return { absentAbstain: ok, currentTop1: false, ok, ordinaryTop1: false, pairRecall: false, reasonCode: ok ? null : "ABSENT_CONFIDENT" }; }
  if (testCase.category === "ordinary-positive") { const ok = prepared.verdict === "confident" && sources[0] === testCase.expectedSource; return { absentAbstain: false, currentTop1: false, ok, ordinaryTop1: ok, pairRecall: false, reasonCode: ok ? null : prepared.verdict === "confident" ? "WRONG_TOP1" : "NOT_CONFIDENT" }; }
  const pairRecall = sources.includes(testCase.currentSource) && sources.includes(testCase.staleSource); const currentTop1 = sources[0] === testCase.currentSource;
  return { absentAbstain: false, currentTop1, ok: currentTop1, ordinaryTop1: false, pairRecall, reasonCode: currentTop1 ? null : !pairRecall ? "PAIR_MISSING" : sources[0] === testCase.staleSource ? "STALE_TOP1" : "DISTRACTOR_TOP1" };
}

function qualityView(outcomes) { return outcomes.map(({ promptBytes: _promptBytes, rerankerLatencyMs: _rerankerLatencyMs, rerankDecision: _rerankDecision, ...item }) => item); }
function decisionView(outcomes) { return outcomes.map(({ caseId, locale, rerankDecision }) => ({ caseId, locale, rerankDecision })); }
function metricRows(outcomes) {
  const rows = [];
  for (const locale of ["all", "ko", "en"]) {
    const localized = locale === "all" ? outcomes : outcomes.filter((item) => item.locale === locale);
    for (const [metric, category, field] of [["pairRecall", "correction-pair", "pairRecall"], ["currentTop1", "correction-pair", "currentTop1"], ["ordinaryTop1", "ordinary-positive", "ordinaryTop1"], ["absentAbstain", "absent", "absentAbstain"]]) {
      const subset = localized.filter((item) => item.category === category); const passed = subset.filter((item) => item[field]).length;
      rows.push({ locale, metric, passed, rate: rate(passed, subset.length), total: subset.length });
    }
  }
  return rows;
}
function getMetric(model, arm, metric) { return model.arms[arm].metrics.find((item) => item.locale === "all" && item.metric === metric).passed; }
function getLocalizedMetric(model, arm, locale, metric) { return model.arms[arm].metrics.find((item) => item.locale === locale && item.metric === metric).passed; }
function summarizeModel(raw) {
  const arms = {};
  for (const arm of ARMS) {
    const [first, second] = raw.trials.map((trial) => trial.arms[arm]);
    const qualityHashes = [first, second].map((item) => sha256(jsonBytes(qualityView(item.outcomes))));
    const promptHashes = [first, second].map((item) => sha256(jsonBytes(item.outcomes.map((outcome) => ({ caseId: outcome.caseId, promptBytes: outcome.promptBytes })))));
    const eligibilityHashes = [first, second].map((item) => sha256(jsonBytes(decisionView(item.outcomes))));
    if (qualityHashes[0] !== qualityHashes[1] || promptHashes[0] !== promptHashes[1] || eligibilityHashes[0] !== eligibilityHashes[1]) throw new Error(`${raw.modelTag}/${arm} pass2 hash mismatch`);
    const latencies = raw.trials.flatMap((trial) => trial.arms[arm].latencyMs); const promptBytes = first.outcomes.map((item) => item.promptBytes);
    const rerankerLatencies = raw.trials.flatMap((trial) => trial.arms[arm].outcomes.filter((item) => item.rerankDecision.eligible).map((item) => item.rerankerLatencyMs));
    const eligibilityByLocale = ["ko", "en"].map((locale) => { const subset = first.outcomes.filter((item) => item.locale === locale); return { eligible: subset.filter((item) => item.rerankDecision.eligible).length, locale, total: subset.length }; });
    const pairByEligibility = [true, false].map((eligible) => { const subset = first.outcomes.filter((item) => item.category === "correction-pair" && item.rerankDecision.eligible === eligible); return { eligible, passed: subset.filter((item) => item.pairRecall).length, total: subset.length }; });
    arms[arm] = { eligibilityByLocale, eligibilityHash: eligibilityHashes[0], latency: { p50Ms: nearestRank(latencies, 0.5), p95Ms: nearestRank(latencies, 0.95), samples: latencies.length }, metrics: metricRows(first.outcomes), pairByEligibility, prompt: { p50Bytes: nearestRank(promptBytes, 0.5), p95Bytes: nearestRank(promptBytes, 0.95), samples: promptBytes.length }, promptHash: promptHashes[0], qualityHash: qualityHashes[0], reranker: summarizeRerankDecisions(raw.trials.flatMap((trial) => trial.arms[arm].outcomes)), rerankerLatency: { p50Ms: nearestRank(rerankerLatencies, .5), p95Ms: nearestRank(rerankerLatencies, .95), samples: rerankerLatencies.length } };
  }
  const paired = raw.trials.flatMap((trial) => trial.arms.B.latencyMs.map((value, index) => value - trial.arms.A.latencyMs[index]));
  return { arms, digest: raw.digest, dimension: raw.dimension, embeddingAccounting: raw.embeddingAccounting, latencyDelta: { p50PairedMs: nearestRank(paired, 0.5), p95DeltaMs: Number((arms.B.latency.p95Ms - arms.A.latency.p95Ms).toFixed(3)), p95PairedMs: nearestRank(paired, 0.95) }, modelTag: raw.modelTag, ollamaVersion: raw.ollamaVersion, resolvedTag: raw.resolvedTag, warmup: raw.warmup };
}
function aggregateMetrics(models, arm) {
  return ["pairRecall", "currentTop1", "ordinaryTop1", "absentAbstain"].map((metric) => { const rows = models.map((model) => model.arms[arm].metrics.find((item) => item.locale === "all" && item.metric === metric)); const passed = rows.reduce((sum, item) => sum + item.passed, 0); const total = rows.reduce((sum, item) => sum + item.total, 0); return { metric, passed, rate: rate(passed, total), total }; });
}

export function buildDiagnosticResult({ models: rawModels, ownerState, reranker, runMetadata, runtimeSources = [] }) {
  const models = rawModels.map(summarizeModel); const aggregate = {};
  for (const arm of ARMS) {
    const latency = rawModels.flatMap((raw) => raw.trials.flatMap((trial) => trial.arms[arm].latencyMs)); const collapsed = rawModels.flatMap((raw) => raw.trials[0].arms[arm].outcomes); const prompts = collapsed.map((item) => item.promptBytes); const allOutcomes = rawModels.flatMap((raw) => raw.trials.flatMap((trial) => trial.arms[arm].outcomes)); const rerankerLatencies = allOutcomes.filter((item) => item.rerankDecision.eligible).map((item) => item.rerankerLatencyMs);
    aggregate[arm] = { eligibilityByLocale: ["ko", "en"].map((locale) => ({ eligible: collapsed.filter((item) => item.locale === locale && item.rerankDecision.eligible).length, locale, total: collapsed.filter((item) => item.locale === locale).length })), latency: { p50Ms: nearestRank(latency, .5), p95Ms: nearestRank(latency, .95), samples: latency.length }, metrics: aggregateMetrics(models, arm), prompt: { p50Bytes: nearestRank(prompts, .5), p95Bytes: nearestRank(prompts, .95), samples: prompts.length }, reranker: summarizeRerankDecisions(allOutcomes), rerankerLatency: { p50Ms: nearestRank(rerankerLatencies, .5), p95Ms: nearestRank(rerankerLatencies, .95), samples: rerankerLatencies.length } };
  }
  const paired = rawModels.flatMap((raw) => raw.trials.flatMap((trial) => trial.arms.B.latencyMs.map((value, index) => value - trial.arms.A.latencyMs[index])));
  const count = (arm, metric) => aggregate[arm].metrics.find((item) => item.metric === metric).passed;
  const gates = {
    absent: count("B", "absentAbstain") >= count("A", "absentAbstain") && models.every((model) => ["ko", "en"].every((locale) => getLocalizedMetric(model, "B", locale, "absentAbstain") >= getLocalizedMetric(model, "A", locale, "absentAbstain"))),
    current: count("B", "currentTop1") >= 135 && models.every((model) => getMetric(model, "B", "currentTop1") >= getMetric(model, "A", "currentTop1")),
    latency: aggregate.B.latency.p95Ms < 5000,
    ordinary: count("B", "ordinaryTop1") >= count("A", "ordinaryTop1") - 1 && models.every((model) => getMetric(model, "B", "ordinaryTop1") >= getMetric(model, "A", "ordinaryTop1") - 1),
    pair: count("B", "pairRecall") >= 154 && count("B", "pairRecall") >= count("A", "pairRecall") + 48,
    prompt: aggregate.B.prompt.p95Bytes <= Math.max(aggregate.A.prompt.p95Bytes * 1.25, aggregate.A.prompt.p95Bytes + 2048)
  };
  const a = aggregate.A.reranker; const b = aggregate.B.reranker; const failureB = b.empty + b.error + b.invalid + b.timeout;
  const warmupsComplete = rawModels.length === 4 && rawModels.every((model) => model.warmup?.afterIndex === true && model.warmup.embeddingRequests === 1 && model.warmup.httpAttempts === 1 && model.warmup.outcome === "success");
  const aClosed = a.eligible === 0 && a.logicalInvocations === 0 && a.httpAttempts === 0 && a.absent === 512;
  const bClosed = b.eligible > 0 && b.logicalInvocations === b.eligible && b.httpAttempts === b.eligible && b.success === b.eligible && failureB === 0;
  const complete = rawModels.length === 4 && aClosed && bClosed && warmupsComplete && ownerState.unchanged;
  const absentBaselineFloor = { passed: count("B", "absentAbstain") >= 29, passedCount: count("B", "absentAbstain"), status: count("B", "absentAbstain") >= 29 ? "MET" : "ABSENT_BASELINE_FLOOR_NOT_MET", threshold: 29, total: 32 };
  const claimLimitations = absentBaselineFloor.passed ? [] : ["ABSENT_BASELINE_FLOOR_NOT_MET"];
  const payload = {
    absoluteChecks: { absentBaselineFloor },
    accounting: { caseArmTrialExecutionsA: 512, caseArmTrialExecutionsB: 512, collapsedCasesPerArm: 256, generativeAnswerRequests: 0, prepareCalls: 1024, rerankerEligibleB: b.eligible, rerankerFailuresB: failureB, rerankerHttpAttemptsA: a.httpAttempts, rerankerHttpAttemptsB: b.httpAttempts, rerankerLogicalInvocationsA: a.logicalInvocations, rerankerLogicalInvocationsB: b.logicalInvocations, rerankerSuccessB: b.success, warmupEmbeddingRequests: rawModels.length, warmupHttpAttempts: rawModels.reduce((sum, model) => sum + (model.warmup?.httpAttempts ?? 0), 0) },
    aggregate, arms: { A: { conflictAwareSelection: false, reranker: false }, B: { conflictAwareSelection: true, reranker: RERANK_MODEL } },
    claimLimitations,
    dataset: { burnedV4OriginalDatasetSha256: BURNED_V4_REPLAY_DATASET.burnedV4OriginalDatasetSha256, cases: 64, corpusEntries: 152, dataOrigin: BURNED_V4_REPLAY_DATASET.dataOrigin, datasetSha256: sha256(jsonBytes(BURNED_V4_REPLAY_DATASET)), exclusions: BURNED_V4_REPLAY_DATASET.exclusionFingerprints, heldOut: false, organicEvidence: false, qualificationStatus: "NOT_QUALIFIED", sourceFreezeCommit: SOURCE_FREEZE_COMMIT, version: BURNED_V4_REPLAY_DATASET.datasetVersion },
    executionStatus: complete ? "COMPLETE" : "INCOMPLETE", latencyDelta: { p50PairedMs: nearestRank(paired, .5), p95DeltaMs: Number((aggregate.B.latency.p95Ms - aggregate.A.latency.p95Ms).toFixed(3)), p95PairedMs: nearestRank(paired, .95) }, models, ownerState, qualification: { gates, qualified: false, reason: "BURNED_V4_DIAGNOSTIC_REPLAY", status: "NOT_QUALIFIED" }, reranker: { ...reranker, timeoutMs: RERANK_TIMEOUT_MS, warmups: 4 }, runtimeSources, topK: TOP_K, trials: 2
  };
  return { payload, payloadHash: sha256(jsonBytes(payload)), runMetadata, schemaVersion: RESULT_SCHEMA_VERSION };
}

export function validateDiagnosticResult(result) {
  validateBurnedV4ReplayDataset(BURNED_V4_REPLAY_DATASET, RECALL_FRESHNESS_DATASET, marker);
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION || result.payloadHash !== sha256(jsonBytes(result.payload))) throw new Error("canonical hash mismatch");
  const { absoluteChecks, accounting, aggregate, claimLimitations, dataset, models, ownerState, qualification } = result.payload;
  if (dataset.dataOrigin !== "synthetic burned v4 diagnostic replay" || dataset.version !== BURNED_V4_REPLAY_DATASET.datasetVersion || dataset.heldOut !== false || dataset.organicEvidence || dataset.qualificationStatus !== "NOT_QUALIFIED" || dataset.sourceFreezeCommit !== SOURCE_FREEZE_COMMIT || dataset.burnedV4OriginalDatasetSha256 !== BURNED_V4_REPLAY_DATASET.burnedV4OriginalDatasetSha256 || dataset.datasetSha256 !== sha256(jsonBytes(BURNED_V4_REPLAY_DATASET)) || canonicalJson(dataset.exclusions) !== canonicalJson(BURNED_V4_REPLAY_DATASET.exclusionFingerprints)) throw new Error("dataset provenance mismatch");
  if (models.length !== 4 || canonicalJson(models.map((item) => item.modelTag)) !== canonicalJson(ALLOWLISTED_MODELS)) throw new Error("model allowlist mismatch");
  if (accounting.caseArmTrialExecutionsA !== 512 || accounting.caseArmTrialExecutionsB !== 512 || accounting.prepareCalls !== 1024 || accounting.rerankerLogicalInvocationsA !== 0 || accounting.rerankerHttpAttemptsA !== 0 || accounting.rerankerEligibleB <= 0 || accounting.rerankerLogicalInvocationsB !== accounting.rerankerEligibleB || accounting.rerankerHttpAttemptsB !== accounting.rerankerEligibleB || accounting.rerankerSuccessB !== accounting.rerankerEligibleB || accounting.rerankerFailuresB !== 0 || accounting.generativeAnswerRequests !== 0 || accounting.warmupEmbeddingRequests !== 4 || accounting.warmupHttpAttempts !== 4) throw new Error("accounting mismatch");
  if (!ownerState.unchanged || ownerState.beforeSha256 !== ownerState.afterSha256 || aggregate.A.latency.samples !== 512 || aggregate.B.latency.samples !== 512 || aggregate.A.prompt.samples !== 256 || aggregate.B.prompt.samples !== 256) throw new Error("sample or owner-state mismatch");
  const a = aggregate.A.reranker; const b = aggregate.B.reranker; const failureB = b.empty + b.error + b.invalid + b.timeout;
  if (a.absent !== 512 || a.eligible !== 0 || a.logicalInvocations !== 0 || a.httpAttempts !== 0 || b.eligible <= 0 || b.logicalInvocations !== b.eligible || b.httpAttempts !== b.eligible || b.success !== b.eligible || failureB !== 0 || models.some((model) => model.warmup.afterIndex !== true || model.warmup.embeddingRequests !== 1 || model.warmup.httpAttempts !== 1 || model.warmup.outcome !== "success")) throw new Error("selective eligibility/warmup mismatch");
  if (models.some((model) => canonicalJson(model.arms.B.eligibilityByLocale.map(({ locale, total }) => ({ locale, total }))) !== canonicalJson([{ locale: "ko", total: 32 }, { locale: "en", total: 32 }])) || canonicalJson(aggregate.B.eligibilityByLocale.map(({ locale, total }) => ({ locale, total }))) !== canonicalJson([{ locale: "ko", total: 128 }, { locale: "en", total: 128 }])) throw new Error("eligibility denominator mismatch");
  for (const arm of ARMS) { const totals = Object.fromEntries(aggregate[arm].metrics.map((item) => [item.metric, item.total])); if (totals.pairRecall !== 192 || totals.currentTop1 !== 192 || totals.ordinaryTop1 !== 32 || totals.absentAbstain !== 32) throw new Error("metric denominator mismatch"); }
  const absentA = aggregate.A.metrics.find((item) => item.metric === "absentAbstain").passed; const absentB = aggregate.B.metrics.find((item) => item.metric === "absentAbstain").passed;
  const absentCausal = absentB >= absentA && models.every((model) => ["ko", "en"].every((locale) => getLocalizedMetric(model, "B", locale, "absentAbstain") >= getLocalizedMetric(model, "A", locale, "absentAbstain")));
  const floorMet = absentB >= 29;
  if (qualification.gates.absent !== absentCausal || canonicalJson(absoluteChecks?.absentBaselineFloor) !== canonicalJson({ passed: floorMet, passedCount: absentB, status: floorMet ? "MET" : "ABSENT_BASELINE_FLOOR_NOT_MET", threshold: 29, total: 32 }) || canonicalJson(claimLimitations) !== canonicalJson(floorMet ? [] : ["ABSENT_BASELINE_FLOOR_NOT_MET"])) throw new Error("absent gate/claim limitation mismatch");
  if (qualification.qualified !== false || qualification.status !== "NOT_QUALIFIED" || qualification.reason !== "BURNED_V4_DIAGNOSTIC_REPLAY") throw new Error("diagnostic replay qualification mismatch");
  const serialized = canonicalJson(result); if (/\/Users\/|\/home\/|\.muse\/|promptText|rawPrompt/iu.test(serialized)) throw new Error("private/raw field in diagnostic result"); return result;
}

async function runtimeSourceProvenance() { return commonRuntimeSourceProvenance(repoRoot, runtimePaths); }
function childEnv(baseUrl, home) { return { HOME: home, LANG: process.env.LANG ?? "C.UTF-8", LC_ALL: process.env.LC_ALL ?? "C.UTF-8", MUSE_LOCAL_ONLY: "true", MUSE_RECALL_RERANK: RERANK_MODEL, OLLAMA_BASE_URL: baseUrl, PATH: process.env.PATH ?? "", TMPDIR: join(home, "tmp") }; }
async function createFixture(embed, home, modelTag) {
  const { embeddingsSidecarPath, loadIndex, prepareGroundedRecall, reindexNotes } = await import("../packages/recall/dist/index.js"); const notesDir = join(home, "notes"); const indexPath = join(home, "notes-index.json"); await mkdir(notesDir, { recursive: true }); const pathToSource = new Map();
  for (const item of BURNED_V4_REPLAY_DATASET.corpus) { const path = resolve(notesDir, sourceFilename(item.source)); pathToSource.set(path, item.source); await writeFile(path, `${item.text}\n`, { mode: 0o600 }); }
  const fetchImpl = async (_url, init) => { const body = JSON.parse(String(init?.body ?? "{}")); return new Response(JSON.stringify({ embedding: await embed(body.prompt, body.model) }), { headers: { "content-type": "application/json" }, status: 200 }); };
  const summary = await reindexNotes({ dir: notesDir, fetchImpl, force: true, indexPath, model: modelTag }); const loaded = await loadIndex(indexPath); const sidecar = await stat(embeddingsSidecarPath(indexPath)); const dimension = loaded?.files[0]?.chunks[0]?.embedding?.length ?? 0; if (!loaded || summary.failed !== 0 || loaded.files.length !== 152 || dimension <= 0 || sidecar.size !== loaded.files.length * dimension * 4) throw new Error("INDEX_CREATION_FAILED"); return { dimension, indexPath, notesDir, prepareGroundedRecall, sourceForFile: (file) => pathToSource.get(resolve(file)) ?? null };
}
function countedReranker(baseFn) {
  const events = [];
  return { events, fn: async (query, texts) => { const start = performance.now(); let response; try { response = await baseFn(query, texts); } catch { response = { httpAttempts: 0, outcome: "error" }; } const execution = response && typeof response === "object" && !Array.isArray(response) && "outcome" in response ? response : Array.isArray(response) && response.length > 0 ? { httpAttempts: 0, order: response, outcome: "success" } : { httpAttempts: 0, outcome: "empty" }; events.push({ decision: { eligible: true, httpAttempts: Number.isSafeInteger(execution.httpAttempts) ? execution.httpAttempts : 0, logicalInvocations: 1, outcome: execution.outcome }, durationMs: performance.now() - start }); return response; } };
}
async function runTrial({ embed, fixture, modelTag, rerankBase, trial }) {
  const arms = { A: { latencyMs: [], outcomes: [] }, B: { latencyMs: [], outcomes: [] } }; const counted = countedReranker(rerankBase);
  for (let index = 0; index < BURNED_V4_REPLAY_DATASET.cases.length; index += 1) { const testCase = BURNED_V4_REPLAY_DATASET.cases[index]; const order = (index + trial) % 2 === 0 ? ARMS : [...ARMS].reverse(); for (const arm of order) { const beforeCalls = counted.events.length; const start = performance.now(); const prepared = await fixture.prepareGroundedRecall({ embedFn: embed, extras: { refineChunks: true }, options: { conflictAwareSelection: arm === "B", embedModel: modelTag, topK: TOP_K }, query: testCase.query, ...(arm === "B" ? { rerankFn: counted.fn } : {}), sources: { notesDir: fixture.notesDir, notesIndexFile: fixture.indexPath } }); const elapsed = performance.now() - start; const afterCalls = counted.events.length; if (afterCalls - beforeCalls > 1 || (arm === "A" && afterCalls !== beforeCalls)) throw new Error("RERANK_LOGICAL_CALL_DRIFT"); const event = afterCalls === beforeCalls ? undefined : counted.events[beforeCalls]; const rerankDecision = arm === "A" ? { eligible: false, httpAttempts: 0, logicalInvocations: 0, outcome: "absent" } : event?.decision ?? { eligible: false, httpAttempts: 0, logicalInvocations: 0, outcome: "ineligible-window" }; const score = scorePrepared(testCase, prepared, fixture.sourceForFile); arms[arm].latencyMs.push(elapsed); arms[arm].outcomes.push({ ...score, arm, caseId: testCase.caseId, category: testCase.category, locale: testCase.locale, promptBytes: Buffer.byteLength(prepared.systemPrompt, "utf8"), rerankDecision, rerankerLatencyMs: event?.durationMs ?? 0 }); } }
  return { arms, modelTag, trial };
}
async function childModel({ baseUrl, home, modelTag, outputPath }) {
  const [{ createOllamaEmbedder }, { createWarmedRecallRerankFn }] = await Promise.all([import("../packages/autoconfigure/dist/index.js"), import("../apps/cli/dist/ask-note-retrieval.js")]); const rawEmbed = createOllamaEmbedder(modelTag, { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl }); let embeddingRequests = 0; const embed = async (text, model = modelTag) => { embeddingRequests += 1; return rawEmbed(text, model); }; const [embedInfo, rerankInfo] = await Promise.all([modelInfo(baseUrl, modelTag), modelInfo(baseUrl, RERANK_MODEL)]); const fixture = await createFixture(embed, home, modelTag); const indexEmbeddingRequests = embeddingRequests; const warmVector = await embed("Post-index embedder readiness check for a fresh selective recall evaluation."); const warmed = await createWarmedRecallRerankFn(process.env, { query: "현재 기준과 current standard를 고르세요.", candidateTexts: ["Retired 기준은 더 이상 유효하지 않습니다.", "The current standard is active now.", "별도 참고값은 현재 기준이 아닙니다.", "A separate observation does not answer the query."] }, { timeoutMs: RERANK_TIMEOUT_MS }); if (!warmed || warmed.warmup.outcome !== "success" || warmed.warmup.httpAttempts !== 1 || !warmed.warmup.order?.length) throw new Error("RERANK_WARMUP_FAILED"); if (fixture.dimension !== warmVector.length) throw new Error("DIMENSION_DRIFT"); const measuredStart = embeddingRequests; const trials = []; for (let trial = 1; trial <= 2; trial += 1) trials.push(await runTrial({ embed, fixture, modelTag, rerankBase: warmed.rerankFn, trial })); const embeddingAccounting = { indexRequests: indexEmbeddingRequests, measuredRequests: embeddingRequests - measuredStart, totalRequests: embeddingRequests, warmupRequests: 1 }; const warmup = { afterIndex: true, embeddingRequests: 1, httpAttempts: warmed.warmup.httpAttempts, outcome: warmed.warmup.outcome }; await writeAtomic(outputPath, jsonBytes({ ...embedInfo, dimension: fixture.dimension, embeddingAccounting, modelTag, reranker: rerankInfo, schemaVersion: CHILD_SCHEMA_VERSION, trials, warmup }));
}

async function parentRun() {
  validateBurnedV4ReplayDataset(BURNED_V4_REPLAY_DATASET, RECALL_FRESHNESS_DATASET, marker); const started = Date.now(); const sessionDir = join(diagnosticsRoot, new Date().toISOString().replaceAll(/[:.]/gu, "-")); await mkdir(sessionDir, { recursive: true }); const ownerRoot = join(homedir(), ".muse"); const before = await manifestTree(ownerRoot); await writeAtomic(join(sessionDir, "owner-before.json"), jsonBytes(before)); const baseUrl = canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL); const models = [];
  for (const modelTag of ALLOWLISTED_MODELS) { if (Date.now() - started >= PARENT_TIMEOUT_MS) throw new Error("PARENT_TIMEOUT"); const home = join(sessionDir, "homes", safeName(modelTag)); await mkdir(join(home, "tmp"), { recursive: true }); const outputPath = join(sessionDir, `${safeName(modelTag)}.json`); const run = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child", modelTag, outputPath, home], { env: childEnv(baseUrl, home), outputPath, timeoutMs: Math.min(CHILD_TIMEOUT_MS, PARENT_TIMEOUT_MS - (Date.now() - started)) }); if (!run.ok) throw new Error(`${modelTag}:${run.reasonCode}`); const value = JSON.parse(await readFile(outputPath, "utf8")); if (value.schemaVersion !== CHILD_SCHEMA_VERSION || value.modelTag !== modelTag || value.trials.length !== 2) throw new Error(`${modelTag}:CHILD_SCHEMA`); models.push(value); }
  const after = await manifestTree(ownerRoot); await writeAtomic(join(sessionDir, "owner-after.json"), jsonBytes(after)); const ownerState = { afterSha256: after.manifestSha256, beforeSha256: before.manifestSha256, unchanged: before.manifestSha256 === after.manifestSha256 }; const reranker = models[0].reranker; if (models.some((model) => canonicalJson(model.reranker) !== canonicalJson(reranker))) throw new Error("RERANKER_PROVENANCE_DRIFT"); const result = buildDiagnosticResult({ models, ownerState, reranker: { digest: reranker.digest, modelTag: RERANK_MODEL, resolvedTag: reranker.resolvedTag }, runMetadata: { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}` }, runtimeSources: await runtimeSourceProvenance() }); await writeAtomic(join(sessionDir, "result.json"), jsonBytes(result)); validateDiagnosticResult(result); process.stdout.write(`${result.payload.executionStatus} NOT_QUALIFIED\n${sessionDir}\n`);
}

async function main() { const args = process.argv.slice(2); if (args[0] === "--child") { await childModel({ baseUrl: canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL), modelTag: args[1], outputPath: args[2], home: args[3] }); return; } if (args.length > 0) throw new Error("UNSUPPORTED_REPLAY_ARGUMENT"); await parentRun(); }
if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) main().catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
