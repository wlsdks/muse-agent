#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ALLOWLISTED_MODELS,
  DATASET_VERSION,
  RECALL_FRESHNESS_DATASET,
  SCORER_VERSION,
  canonicalJson,
  canonicalLocalBaseUrl,
  datasetSha256,
  evaluateCaseWithArms,
  memoizeEmbed,
  sha256,
  validateCanonicalResult as validateFreshnessResult,
  validateDataset
} from "./eval-recall-freshness-ablation.mjs";

export const RESULT_SCHEMA_VERSION = "muse-recall-candidate-pool.v1";
export const CHILD_SCHEMA_VERSION = "muse-recall-candidate-pool-child.v1";
export const TOP_K = Object.freeze([4, 8, 12]);
export const RANK_OPTIONS_BASE = Object.freeze({ bm25: false, diversify: true, hybrid: true, minScore: 0.1, mmrLambda: 0.5, rrfK: 60 });
export const CORRECTION_REASON_CODES = Object.freeze(["DISTRACTOR_TOP1", "PAIR_MISSING", "STALE_TOP1"]);
export const TOP4_BASELINE = Object.freeze({
  "nomic-embed-text": Object.freeze({ museCurrentTop1: 1, pairRetained: 1, rawCurrentTop1: 1 }),
  "nomic-embed-text-v2-moe": Object.freeze({ museCurrentTop1: 4, pairRetained: 5, rawCurrentTop1: 4 }),
  "embeddinggemma": Object.freeze({ museCurrentTop1: 1, pairRetained: 1, rawCurrentTop1: 1 }),
  "qwen3-embedding:0.6b": Object.freeze({ museCurrentTop1: 1, pairRetained: 1, rawCurrentTop1: 1 })
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "docs", "benchmarks", "recall-freshness-ablation.json");
const trackedBase = join(repoRoot, "docs", "benchmarks", "recall-candidate-pool");
const trackedPaths = Object.freeze({ csv: `${trackedBase}.csv`, json: `${trackedBase}.json`, md: `${trackedBase}.md`, svg: `${trackedBase}.svg` });
const diagnosticsRoot = join(repoRoot, ".muse-dev", "evals", "recall-candidate-pool");
const CHILD_TIMEOUT_MS = 10 * 60 * 1_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;

function jsonBytes(value) { return `${canonicalJson(value)}\n`; }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) throw new Error(`${label} fields mismatch`);
}
function rate(value, total) { return Number((value / total).toFixed(6)); }
function correctionCases() { return RECALL_FRESHNESS_DATASET.cases.filter((item) => item.category === "correction-pair"); }
export function corpusSha256() { return sha256(jsonBytes(RECALL_FRESHNESS_DATASET.corpus)); }

export async function readAcceptedBaseline(path = baselinePath) {
  const bytes = await readFile(path, "utf8");
  if (!bytes.endsWith("\n")) throw new Error("baseline JSON must end with LF");
  const result = validateFreshnessResult(JSON.parse(bytes));
  if (bytes !== jsonBytes(result)) throw new Error("baseline canonical bytes mismatch");
  if (result.payload.status !== "UNCHANGED" || result.payload.dataset.datasetSha256 !== datasetSha256()) throw new Error("baseline dataset/status drift");
  for (const model of result.payload.models) {
    const raw = model.metrics.find((item) => item.arm === "raw-retrieval" && item.category === "correction-pair");
    const muse = model.metrics.find((item) => item.arm === "muse-freshness" && item.category === "correction-pair");
    const retained = raw.total - model.failedCases.filter((item) => item.arm === "raw-retrieval" && item.category === "correction-pair" && item.reasonCode === "PAIR_MISSING").length;
    if (canonicalJson({ museCurrentTop1: muse.passed, pairRetained: retained, rawCurrentTop1: raw.passed }) !== canonicalJson(TOP4_BASELINE[model.modelTag])) throw new Error(`baseline top-4 drift: ${model.modelTag}`);
  }
  return { bytes, result };
}

export async function executeCandidateTrial({ classify, confidentAt, demote, embed, modelTag, rank, trial }) {
  const memo = memoizeEmbed(embed); const observations = []; let rawRankCalls = 0;
  for (const k of TOP_K) for (const testCase of correctionCases()) {
    const rawMatches = await rank(testCase.query, RECALL_FRESHNESS_DATASET.corpus, { ...RANK_OPTIONS_BASE, topK: k, embed: memo.embed }); rawRankCalls += 1;
    const verdicts = evaluateCaseWithArms(testCase, rawMatches, { classify, confidentAt, demote });
    const rawVerdict = verdicts.find((item) => item.arm === "raw-retrieval"); const museVerdict = verdicts.find((item) => item.arm === "muse-freshness");
    const sources = new Set(rawMatches.map((item) => item.source));
    observations.push({ caseId: testCase.caseId, k, museVerdict: { ok: museVerdict.ok, reasonCode: museVerdict.reasonCode }, pairRetained: sources.has(testCase.currentSource) && sources.has(testCase.staleSource), rawVerdict: { ok: rawVerdict.ok, reasonCode: rawVerdict.reasonCode } });
  }
  return { accounting: { armVerdicts: observations.length * 2, benchmarkEmbeddingRequests: memo.requestCount(), caseKObservations: observations.length, rawRankCalls }, modelTag, observations, schemaVersion: CHILD_SCHEMA_VERSION, trial, verdictHash: sha256(jsonBytes(observations)) };
}

export function validateCandidatePreflight(value, modelTag) {
  exactKeys(value, ["digest", "dimension", "modelTag", "ollamaVersion", "preflightEmbeddingRequests", "resolvedTag", "schemaVersion"], "preflight");
  if (value.schemaVersion !== CHILD_SCHEMA_VERSION || value.modelTag !== modelTag || value.preflightEmbeddingRequests !== 1 || !Number.isInteger(value.dimension) || value.dimension <= 0 || typeof value.resolvedTag !== "string" || !value.resolvedTag || typeof value.ollamaVersion !== "string" || !value.ollamaVersion || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.digest)) throw new Error("preflight provenance/vector mismatch");
  return value;
}
export function validateCandidateTrial(value, modelTag, trial) {
  exactKeys(value, ["accounting", "modelTag", "observations", "schemaVersion", "trial", "verdictHash"], "trial");
  exactKeys(value.accounting, ["armVerdicts", "benchmarkEmbeddingRequests", "caseKObservations", "rawRankCalls"], "trial accounting");
  if (value.schemaVersion !== CHILD_SCHEMA_VERSION || value.modelTag !== modelTag || value.trial !== trial || value.accounting.armVerdicts !== 120 || value.accounting.benchmarkEmbeddingRequests !== 80 || value.accounting.caseKObservations !== 60 || value.accounting.rawRankCalls !== 60 || value.observations.length !== 60 || value.verdictHash !== sha256(jsonBytes(value.observations))) throw new Error("trial count/hash mismatch");
  for (let index = 0; index < value.observations.length; index += 1) {
    const item = value.observations[index]; exactKeys(item, ["caseId", "k", "museVerdict", "pairRetained", "rawVerdict"], "observation");
    if (item.k !== TOP_K[Math.floor(index / 20)] || item.caseId !== correctionCases()[index % 20].caseId || typeof item.pairRetained !== "boolean") throw new Error("ordered observation mismatch");
    for (const verdict of [item.rawVerdict, item.museVerdict]) { exactKeys(verdict, ["ok", "reasonCode"], "terminal verdict"); if (typeof verdict.ok !== "boolean" || (verdict.ok ? verdict.reasonCode !== null : typeof verdict.reasonCode !== "string")) throw new Error("terminal verdict mismatch"); }
    for (const verdict of [item.rawVerdict, item.museVerdict]) if (!verdict.ok && !CORRECTION_REASON_CODES.includes(verdict.reasonCode)) throw new Error("terminal reason allowlist mismatch");
    if (item.pairRetained === [item.rawVerdict, item.museVerdict].some((verdict) => verdict.reasonCode === "PAIR_MISSING")) throw new Error("pair retention reconciliation mismatch");
  }
  return value;
}
export function aggregateCandidateModel(preflight, trials, { enforceTop4 = true } = {}) {
  if (trials.length !== 2 || trials[0].verdictHash !== trials[1].verdictHash) throw new Error("trial verdict hash mismatch");
  const metrics = TOP_K.map((k) => { const rows = trials[0].observations.filter((item) => item.k === k); const pairRetained = rows.filter((item) => item.pairRetained).length; const rawCurrentTop1 = rows.filter((item) => item.rawVerdict.ok).length; const museCurrentTop1 = rows.filter((item) => item.museVerdict.ok).length; return { k, museCurrentTop1, museRate: rate(museCurrentTop1, 20), pairRetained, pairRetentionRate: rate(pairRetained, 20), rawCurrentTop1, rawRate: rate(rawCurrentTop1, 20), total: 20 }; });
  if (enforceTop4 && canonicalJson({ museCurrentTop1: metrics[0].museCurrentTop1, pairRetained: metrics[0].pairRetained, rawCurrentTop1: metrics[0].rawCurrentTop1 }) !== canonicalJson(TOP4_BASELINE[preflight.modelTag])) throw new Error("topK4 baseline mismatch");
  return { calibrated: preflight.calibrated, confidentAt: preflight.confidentAt, digest: preflight.digest, dimension: preflight.dimension, metrics, modelTag: preflight.modelTag, reliable: true, resolvedTag: preflight.resolvedTag, trialVerdictHash: trials[0].verdictHash };
}

export function buildCandidateResult({ baseline, models, runMetadata }) {
  const complete = models.length === 4 && canonicalJson(models.map((item) => item.modelTag)) === canonicalJson(ALLOWLISTED_MODELS);
  const payload = {
    accounting: { armVerdicts: models.length * 240, benchmarkEmbeddingRequests: models.length * 160, caseKTrialObservations: models.length * 120, correctionCases: 20, preflightEmbeddingRequests: models.length, rawRankCalls: models.length * 120, successfulModelTrials: models.length * 2, totalEmbeddingRequests: models.length * 161 },
    baseline: { corpusEntries: 60, corpusSha256: corpusSha256(), datasetSha256: datasetSha256(), datasetVersion: DATASET_VERSION, freshnessPayloadHash: baseline.payloadHash, scorerVersion: SCORER_VERSION },
    executionStatus: complete ? "COMPLETE" : "UNVERIFIED", models, rankOptions: { ...RANK_OPTIONS_BASE, topK: [...TOP_K] }, topK: [...TOP_K]
  };
  return { payload, payloadHash: sha256(jsonBytes(payload)), runMetadata, schemaVersion: RESULT_SCHEMA_VERSION };
}

function scanTracked(value, path = "") {
  if (Array.isArray(value)) return value.forEach((item, index) => scanTracked(item, `${path}/${index}`));
  if (value && typeof value === "object") { for (const [key, child] of Object.entries(value)) { if (/prompt|output|trace|free.?text/iu.test(key)) throw new Error(`forbidden tracked field ${path}/${key}`); scanTracked(child, `${path}/${key}`); } return; }
  if (typeof value === "string" && (/\/Users\//iu.test(value) || /\/home\//iu.test(value) || /\.muse/iu.test(value) || /jinan/iu.test(value) || /(?:sk-|ghp_|github_pat_|Bearer\s|AKIA)[A-Za-z0-9_\-]*/u.test(value))) throw new Error(`private token in tracked aggregate ${path}`);
}
export function validateCandidateResult(result) {
  exactKeys(result, ["payload", "payloadHash", "runMetadata", "schemaVersion"], "result"); exactKeys(result.payload, ["accounting", "baseline", "executionStatus", "models", "rankOptions", "topK"], "payload"); exactKeys(result.runMetadata, ["generatedAt", "node", "ollamaVersion", "platform"], "run metadata");
  exactKeys(result.payload.accounting, ["armVerdicts", "benchmarkEmbeddingRequests", "caseKTrialObservations", "correctionCases", "preflightEmbeddingRequests", "rawRankCalls", "successfulModelTrials", "totalEmbeddingRequests"], "accounting");
  exactKeys(result.payload.baseline, ["corpusEntries", "corpusSha256", "datasetSha256", "datasetVersion", "freshnessPayloadHash", "scorerVersion"], "baseline");
  exactKeys(result.payload.rankOptions, ["bm25", "diversify", "hybrid", "minScore", "mmrLambda", "rrfK", "topK"], "rank options");
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION || result.payloadHash !== sha256(jsonBytes(result.payload)) || result.payload.executionStatus !== "COMPLETE" || canonicalJson(result.payload.topK) !== canonicalJson(TOP_K) || canonicalJson(result.payload.rankOptions) !== canonicalJson({ ...RANK_OPTIONS_BASE, topK: [...TOP_K] })) throw new Error("canonical candidate hash/version mismatch");
  if (result.payload.baseline.datasetSha256 !== datasetSha256() || result.payload.baseline.corpusSha256 !== corpusSha256() || result.payload.baseline.corpusEntries !== 60 || result.payload.baseline.datasetVersion !== DATASET_VERSION || result.payload.baseline.scorerVersion !== SCORER_VERSION || !/^[a-f0-9]{64}$/u.test(result.payload.baseline.freshnessPayloadHash)) throw new Error("baseline provenance mismatch");
  const expectedAccounting = { armVerdicts: 960, benchmarkEmbeddingRequests: 640, caseKTrialObservations: 480, correctionCases: 20, preflightEmbeddingRequests: 4, rawRankCalls: 480, successfulModelTrials: 8, totalEmbeddingRequests: 644 };
  if (canonicalJson(result.payload.accounting) !== canonicalJson(expectedAccounting) || canonicalJson(result.payload.models.map((item) => item.modelTag)) !== canonicalJson(ALLOWLISTED_MODELS)) throw new Error("canonical candidate accounting mismatch");
  for (const model of result.payload.models) {
    exactKeys(model, ["calibrated", "confidentAt", "digest", "dimension", "metrics", "modelTag", "reliable", "resolvedTag", "trialVerdictHash"], `model ${model.modelTag}`);
    if (typeof model.calibrated !== "boolean" || model.reliable !== true || !Number.isFinite(model.confidentAt) || model.confidentAt <= 0 || model.confidentAt > 1 || !Number.isInteger(model.dimension) || model.dimension <= 0 || typeof model.resolvedTag !== "string" || !model.resolvedTag || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(model.digest) || !/^[a-f0-9]{64}$/u.test(model.trialVerdictHash) || model.metrics.length !== 3) throw new Error("model provenance mismatch");
    for (const item of model.metrics) { exactKeys(item, ["k", "museCurrentTop1", "museRate", "pairRetained", "pairRetentionRate", "rawCurrentTop1", "rawRate", "total"], "candidate metric"); if (!TOP_K.includes(item.k) || item.total !== 20 || [item.museCurrentTop1, item.pairRetained, item.rawCurrentTop1].some((count) => !Number.isInteger(count) || count < 0 || count > 20) || item.museRate !== rate(item.museCurrentTop1, 20) || item.pairRetentionRate !== rate(item.pairRetained, 20) || item.rawRate !== rate(item.rawCurrentTop1, 20)) throw new Error("candidate metric reconciliation mismatch"); }
    const top4 = model.metrics[0]; if (canonicalJson({ museCurrentTop1: top4.museCurrentTop1, pairRetained: top4.pairRetained, rawCurrentTop1: top4.rawCurrentTop1 }) !== canonicalJson(TOP4_BASELINE[model.modelTag])) throw new Error("topK4 accepted result mismatch");
  }
  scanTracked(result); return result;
}

function csvEscape(value) { const text = String(value); return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function renderCsv(result) { const fields = ["modelTag", "digest", "k", "pairRetained", "total", "pairRetentionRate", "rawCurrentTop1", "rawRate", "museCurrentTop1", "museRate", "executionStatus"]; const rows = result.payload.models.flatMap((model) => model.metrics.map((item) => ({ ...item, digest: model.digest, executionStatus: result.payload.executionStatus, modelTag: model.modelTag }))); return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvEscape(row[field])).join(",")).join("\n")}\n`; }
export function renderMarkdown(result) { const lines = ["# Recall candidate-pool diagnostic", "", "**COMPLETE** — local-live retrieval component diagnostic; zero generative requests.", "", "| Model | topK | Pair retained | Raw correction pass | Muse correction pass |", "| --- | ---: | ---: | ---: | ---: |"]; for (const model of result.payload.models) for (const item of model.metrics) lines.push(`| ${model.modelTag} | ${item.k} | ${item.pairRetained}/${item.total} | ${item.rawCurrentTop1}/${item.total} | ${item.museCurrentTop1}/${item.total} |`); lines.push("", "**Correction pass = pair retained + current top-1 under the shared terminal scorer.**", "", `Accounting: ${result.payload.accounting.rawRankCalls} raw rank calls · ${result.payload.accounting.totalEmbeddingRequests} total embedding requests (${result.payload.accounting.preflightEmbeddingRequests} preflight + ${result.payload.accounting.benchmarkEmbeddingRequests} benchmark) · ${result.payload.accounting.caseKTrialObservations} case-K trial observations · ${result.payload.accounting.armVerdicts} arm verdicts.`, "", "This is a controlled local-live retrieval diagnostic over synthetic correction cases. Repeats prove reliability and are collapsed, not counted as independent truth. It does not improve the 10/11 agent aggregate and does not prove organic personal effectiveness.", "", "**agent capability remains aggregate FAILED · organic effectiveness = NOT_PROVEN · generative requests = 0**", ""); return lines.join("\n"); }
function escapeXml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function renderSvg(result) {
  const rows = result.payload.models.flatMap((model) => model.metrics.map((item) => ({ item, model }))); const body = rows.map(({ item, model }, index) => { const y = 150 + index * 43; const scale = 20; return `<text x="40" y="${y + 15}" class="model">${escapeXml(model.modelTag)}</text><text x="285" y="${y + 15}" class="k">K=${item.k}</text><rect x="350" y="${y}" width="${item.pairRetained / scale * 260}" height="9" rx="3" fill="#0891b2"/><rect x="350" y="${y + 12}" width="${item.rawCurrentTop1 / scale * 260}" height="9" rx="3" fill="#94a3b8"/><rect x="350" y="${y + 24}" width="${item.museCurrentTop1 / scale * 260}" height="9" rx="3" fill="#2563eb"/><text x="${360 + item.pairRetained / scale * 260}" y="${y + 8}" class="value">pair ${item.pairRetained}/20</text><text x="${360 + item.rawCurrentTop1 / scale * 260}" y="${y + 20}" class="value">raw pass ${item.rawCurrentTop1}/20</text><text x="${360 + item.museCurrentTop1 / scale * 260}" y="${y + 32}" class="value">Muse pass ${item.museCurrentTop1}/20</text>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="860" viewBox="0 0 1200 860" role="img" aria-labelledby="title desc"><title id="title">Recall candidate-pool diagnostic</title><desc id="desc">Within-row pair-retention and correction-pass counts for four local embedding models at top K four, eight, and twelve. A correction pass requires pair retention and current top-1.</desc><style>text{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;fill:#172033}.title{font-size:27px;font-weight:760}.sub{font-size:13px;fill:#536075}.model{font-size:12px;font-weight:650}.k{font-size:12px;fill:#536075}.value{font-size:10px}.footer{font-size:12px;font-weight:650}</style><rect width="1200" height="860" fill="#fff"/><text x="40" y="42" class="title">Recall candidate-pool diagnostic · ${result.payload.executionStatus}</text><text x="40" y="70" class="sub">local-live retrieval component · correction 20 · topK 4/8/12 · four models × two reliable trials · generative requests 0</text><text x="280" y="100" class="sub">Legend</text><rect x="350" y="91" width="14" height="9" fill="#0891b2"/><text x="372" y="100" class="sub">pair retained</text><rect x="480" y="91" width="14" height="9" fill="#94a3b8"/><text x="502" y="100" class="sub">raw correction pass</text><rect x="650" y="91" width="14" height="9" fill="#2563eb"/><text x="672" y="100" class="sub">Muse correction pass</text>${body}<line x1="40" y1="760" x2="1160" y2="760" stroke="#dce3ec"/><text x="40" y="790" class="footer">pass = pair retained + current top-1</text><text x="40" y="812" class="footer">diagnostic only · repeats collapsed · agent aggregate remains FAILED · organic effectiveness NOT_PROVEN</text></svg>\n`;
}
async function readCanonical(path) { const bytes = await readFile(path, "utf8"); if (!bytes.endsWith("\n")) throw new Error("canonical JSON must end with LF"); const result = validateCandidateResult(JSON.parse(bytes)); if (bytes !== jsonBytes(result)) throw new Error("canonical JSON bytes mismatch"); return result; }
export async function validateArtifacts(paths = trackedPaths) { const result = await readCanonical(paths.json); const expected = { csv: renderCsv(result), md: renderMarkdown(result), svg: renderSvg(result) }; for (const key of ["csv", "md", "svg"]) if (await readFile(paths[key], "utf8") !== expected[key]) throw new Error(`${key.toUpperCase()} does not reconcile with canonical JSON`); const baseline = await readAcceptedBaseline(); if (result.payload.baseline.freshnessPayloadHash !== baseline.result.payloadHash) throw new Error("accepted freshness payload hash drift"); return result; }
async function writeAtomic(path, value, mode = 0o600) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, value, { mode }); await rename(temporary, path); }
export async function spawnWithTimeout(command, args, { env, outputPath, timeoutMs }) { await rm(outputPath, { force: true }); return new Promise((resolve) => { const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "ignore", "ignore"] }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs); child.once("error", () => { clearTimeout(timer); resolve({ ok: false, reasonCode: "TRIAL_FAILED" }); }); child.once("close", async (code) => { clearTimeout(timer); if (timedOut) return resolve({ ok: false, reasonCode: "TIMEOUT" }); if (code !== 0) return resolve({ ok: false, reasonCode: "TRIAL_FAILED" }); try { await stat(outputPath); resolve({ ok: true }); } catch { resolve({ ok: false, reasonCode: "PARTIAL_OUTPUT" }); } }); }); }
function scrubbedEnv(baseUrl, home) { return { HOME: home, LANG: process.env.LANG ?? "C.UTF-8", LC_ALL: process.env.LC_ALL ?? "C.UTF-8", MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl, PATH: process.env.PATH ?? "", TMPDIR: join(home, "tmp") }; }

async function childPreflight({ baseUrl, modelTag, outputPath }) {
  const { createOllamaEmbedder } = await import("../packages/autoconfigure/dist/index.js"); const [versionResponse, tagsResponse] = await Promise.all([fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(10_000) }), fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) })]); if (!versionResponse.ok || !tagsResponse.ok) throw new Error("OLLAMA_UNREACHABLE");
  const version = await versionResponse.json(); const tags = await tagsResponse.json(); const found = Array.isArray(tags.models) ? tags.models.find((item) => item.name === modelTag || item.model === modelTag || item.name === `${modelTag}:latest`) : undefined; if (!found) throw new Error("MODEL_MISSING"); const digest = found.digest; if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(digest)) throw new Error("DIGEST_MISSING"); const embed = createOllamaEmbedder(modelTag, { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl }); const vector = await embed("synthetic candidate-pool preflight probe"); if (!Array.isArray(vector) || vector.length === 0 || vector.some((item) => !Number.isFinite(item))) throw new Error("INVALID_VECTOR"); await writeAtomic(outputPath, jsonBytes({ digest, dimension: vector.length, modelTag, ollamaVersion: version.version, preflightEmbeddingRequests: 1, resolvedTag: found.name ?? found.model, schemaVersion: CHILD_SCHEMA_VERSION }));
}
async function childTrial({ baseUrl, modelTag, outputPath, trial }) {
  const [{ classifyRetrievalConfidence, rankKnowledgeChunks }, { createOllamaEmbedder }, { demoteStale }] = await Promise.all([import("../packages/agent-core/dist/index.js"), import("../packages/autoconfigure/dist/index.js"), import("../packages/recall/dist/index.js")]); const embed = createOllamaEmbedder(modelTag, { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl }); const result = await executeCandidateTrial({ classify: classifyRetrievalConfidence, confidentAt: Number(process.env.MUSE_CANDIDATE_CONFIDENT_AT), demote: demoteStale, embed, modelTag, rank: rankKnowledgeChunks, trial }); await writeAtomic(outputPath, jsonBytes(result));
}
function parseInternalArgs(args) { const out = {}; for (let index = 0; index < args.length; index += 2) { if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("malformed internal options"); out[args[index].slice(2)] = args[index + 1]; } return out; }
export function normalizeCliArgs(args) { return args.filter((item) => item !== "--"); }
async function runModelChildren(modelTag, baseUrl, sessionDir) {
  const safe = modelTag.replaceAll(/[^a-z0-9.-]/giu, "_"); const home = join(sessionDir, "homes", safe); await mkdir(join(home, "tmp"), { recursive: true }); const env = scrubbedEnv(baseUrl, home); const preflightPath = join(sessionDir, `${safe}-preflight.json`); const preflightRun = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child-preflight", "1", "--model", modelTag, "--out", preflightPath], { env, outputPath: preflightPath, timeoutMs: PREFLIGHT_TIMEOUT_MS }); if (!preflightRun.ok) return preflightRun;
  let preflight; try { preflight = validateCandidatePreflight(JSON.parse(await readFile(preflightPath, "utf8")), modelTag); } catch { return { ok: false, reasonCode: "INVALID_VECTOR" }; }
  const { isCalibratedEmbedder, resolveRecallConfidentAt } = await import("../packages/agent-core/dist/index.js"); preflight = { ...preflight, calibrated: isCalibratedEmbedder(modelTag), confidentAt: resolveRecallConfidentAt({ MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl }, modelTag) }; const trials = [];
  for (let trial = 1; trial <= 2; trial += 1) { const path = join(sessionDir, `${safe}-trial-${trial}.json`); const run = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child-trial", "1", "--model", modelTag, "--out", path, "--trial", String(trial)], { env: { ...env, MUSE_CANDIDATE_CONFIDENT_AT: String(preflight.confidentAt) }, outputPath: path, timeoutMs: CHILD_TIMEOUT_MS }); if (!run.ok) return run; try { trials.push(validateCandidateTrial(JSON.parse(await readFile(path, "utf8")), modelTag, trial)); } catch { return { ok: false, reasonCode: "COUNT_MISMATCH" }; } }
  try { return { model: aggregateCandidateModel(preflight, trials), ok: true, ollamaVersion: preflight.ollamaVersion }; } catch { return { ok: false, reasonCode: "HASH_MISMATCH" }; }
}
async function promoteTracked(result) { validateCandidateResult(result); const stage = join(diagnosticsRoot, `stage-${process.pid}`); await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true }); const paths = { csv: join(stage, "result.csv"), json: join(stage, "result.json"), md: join(stage, "result.md"), svg: join(stage, "result.svg") }; await writeAtomic(paths.json, jsonBytes(result)); await writeAtomic(paths.csv, renderCsv(result)); await writeAtomic(paths.md, renderMarkdown(result)); await writeAtomic(paths.svg, renderSvg(result)); await validateArtifacts(paths); for (const key of ["csv", "md", "svg", "json"]) await rename(paths[key], trackedPaths[key]); await rm(stage, { recursive: true, force: true }); await validateArtifacts(); }
async function parentMain(smokeModel) {
  const baseline = await readAcceptedBaseline(); const { detectStaleMarker } = await import("../packages/recall/dist/index.js"); validateDataset(RECALL_FRESHNESS_DATASET, detectStaleMarker); const baseUrl = canonicalLocalBaseUrl(process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"); const models = smokeModel ? [smokeModel] : [...ALLOWLISTED_MODELS]; if (models.some((item) => !ALLOWLISTED_MODELS.includes(item))) throw new Error("model is not allowlisted"); const sessionDir = join(diagnosticsRoot, new Date().toISOString().replaceAll(/[:.]/gu, "-")); await mkdir(sessionDir, { recursive: true }); const completed = []; const diagnostics = [];
  for (const modelTag of models) { const outcome = await runModelChildren(modelTag, baseUrl, sessionDir); diagnostics.push({ modelTag, ok: outcome.ok, reasonCode: outcome.ok ? null : outcome.reasonCode }); if (outcome.ok) completed.push(outcome); }
  await writeAtomic(join(sessionDir, "summary.json"), jsonBytes({ diagnostics, requestedModels: models })); if (completed.length !== models.length) throw new Error(`UNVERIFIED ${canonicalJson(diagnostics)}`);
  if (smokeModel) { process.stdout.write(`${canonicalJson({ accounting: { armVerdicts: 240, benchmarkEmbeddingRequests: 160, caseKTrialObservations: 120, preflightEmbeddingRequests: 1, rawRankCalls: 120, totalEmbeddingRequests: 161 }, model: smokeModel, status: "SMOKE_PASS", trials: 2 })}\n`); return; }
  const versions = new Set(completed.map((item) => item.ollamaVersion)); if (versions.size !== 1) throw new Error("UNVERIFIED Ollama version changed"); const result = buildCandidateResult({ baseline: baseline.result, models: completed.map((item) => item.model), runMetadata: { generatedAt: new Date().toISOString(), node: process.version, ollamaVersion: [...versions][0], platform: `${process.platform}/${process.arch}` } }); await promoteTracked(result); process.stdout.write(`${canonicalJson({ artifact: trackedPaths.json, status: result.payload.executionStatus })}\n`);
}
async function main() { const args = normalizeCliArgs(process.argv.slice(2)); if (args[0] === "--validate") { if (args.length !== 1) throw new Error("validate takes no options"); const result = await validateArtifacts(); process.stdout.write(`${canonicalJson({ payloadHash: result.payloadHash, status: result.payload.executionStatus })}\n`); return; } if (args[0] === "--child-preflight" || args[0] === "--child-trial") { const mode = args[0]; const options = parseInternalArgs(args.slice(2)); const baseUrl = canonicalLocalBaseUrl(process.env.OLLAMA_BASE_URL); if (!options.model || !options.out) throw new Error("missing child options"); if (mode === "--child-preflight") await childPreflight({ baseUrl, modelTag: options.model, outputPath: options.out }); else await childTrial({ baseUrl, modelTag: options.model, outputPath: options.out, trial: Number(options.trial) }); return; } if (args.length === 0) return parentMain(); if (args.length === 2 && args[0] === "--smoke-model") return parentMain(args[1]); throw new Error("Usage: eval-recall-candidate-pool.mjs [--smoke-model <allowlisted-model>|--validate]"); }
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
