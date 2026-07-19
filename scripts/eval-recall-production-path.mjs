#!/usr/bin/env node

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  sha256,
  validateDataset
} from "./eval-recall-freshness-ablation.mjs";
import { spawnWithTimeout } from "./eval-recall-candidate-pool.mjs";

export const CLI_TOP_K = 3;
export const REFINE_CHUNKS = true;
export const RESULT_SCHEMA_VERSION = "muse-recall-production-path.v1";
export const TRIAL_SCHEMA_VERSION = "muse-recall-production-path-trial.v1";
export const PRODUCTION_SCORER_VERSION = "recall-production-path-terminal-scorer.v1";
export const REASON_CODES = Object.freeze([
  "ABSENT_CONFIDENT",
  "DISTRACTOR_TOP1",
  "NOT_CONFIDENT",
  "PAIR_MISSING",
  "STALE_TOP1",
  "WRONG_TOP1"
]);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const trackedBase = join(repoRoot, "docs", "benchmarks", "recall-production-path");
const trackedPaths = Object.freeze({
  csv: `${trackedBase}.csv`,
  json: `${trackedBase}.json`,
  md: `${trackedBase}.md`,
  svg: `${trackedBase}.svg`
});
const diagnosticsRoot = join(repoRoot, ".muse-dev", "evals", "recall-production-path");
const CHILD_TIMEOUT_MS = 10 * 60 * 1_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
const RUNTIME_SOURCE_PATHS = Object.freeze([
  "packages/recall/dist/index.js",
  "packages/recall/dist/pipeline.js",
  "packages/recall/dist/ask-note-retrieval.js",
  "packages/recall/dist/notes-index.js",
  "apps/cli/src/ask-context-setup.ts",
  "apps/cli/src/commands-ask.ts"
]);

function jsonBytes(value) { return `${canonicalJson(value)}\n`; }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) throw new Error(`${label} fields mismatch`);
}
function rate(passed, total) { return Number((passed / total).toFixed(6)); }
function corpusSha256() { return sha256(jsonBytes(RECALL_FRESHNESS_DATASET.corpus)); }
export async function runtimeSourceProvenance() {
  return Promise.all(RUNTIME_SOURCE_PATHS.map(async (path) => ({ path, sha256: sha256(await readFile(join(repoRoot, path))) })));
}
function safeModelName(model) { return model.replaceAll(/[^a-z0-9.-]/giu, "_"); }
function sourceFilename(source) { return `${source.replaceAll(":", "__")}.md`; }
function scrubbedEnv(baseUrl, home) {
  return {
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    MUSE_LOCAL_ONLY: "true",
    OLLAMA_BASE_URL: baseUrl,
    PATH: process.env.PATH ?? "",
    TMPDIR: join(home, "tmp")
  };
}
async function writeAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, { mode });
  await rename(temporary, path);
}

export function scoreProductionCase(testCase, prepared, sourceForFile) {
  const sources = prepared.scored.map((item) => sourceForFile(item.file));
  if (testCase.category === "absent") {
    return prepared.verdict === "ambiguous" || prepared.verdict === "none"
      ? { ok: true, reasonCode: null }
      : { ok: false, reasonCode: "ABSENT_CONFIDENT" };
  }
  if (testCase.category === "ordinary-positive") {
    if (prepared.verdict !== "confident") return { ok: false, reasonCode: "NOT_CONFIDENT" };
    return sources[0] === testCase.expectedSource
      ? { ok: true, reasonCode: null }
      : { ok: false, reasonCode: "WRONG_TOP1" };
  }
  if (!sources.includes(testCase.currentSource) || !sources.includes(testCase.staleSource)) {
    return { ok: false, reasonCode: "PAIR_MISSING" };
  }
  if (sources[0] === testCase.currentSource) return { ok: true, reasonCode: null };
  return sources[0] === testCase.staleSource
    ? { ok: false, reasonCode: "STALE_TOP1" }
    : { ok: false, reasonCode: "DISTRACTOR_TOP1" };
}

export async function executeProductionTrial({
  embedFn,
  indexPath,
  modelTag,
  notesDir,
  prepare,
  sourceForFile,
  trial
}) {
  const verdicts = [];
  for (const testCase of RECALL_FRESHNESS_DATASET.cases) {
    const prepared = await prepare({
      embedFn,
      extras: { refineChunks: REFINE_CHUNKS },
      options: { embedModel: modelTag, topK: CLI_TOP_K },
      query: testCase.query,
      sources: { notesDir, notesIndexFile: indexPath }
    });
    verdicts.push({
      caseId: testCase.caseId,
      category: testCase.category,
      ...scoreProductionCase(testCase, prepared, sourceForFile)
    });
  }
  return {
    accounting: { executedCases: verdicts.length, prepareCalls: verdicts.length },
    modelTag,
    schemaVersion: TRIAL_SCHEMA_VERSION,
    trial,
    verdictHash: sha256(`${canonicalJson(verdicts)}\n`),
    verdicts
  };
}

export function validateProductionTrial(value, modelTag, trial) {
  exactKeys(value, ["accounting", "index", "modelTag", "schemaVersion", "trial", "verdictHash", "verdicts"], "trial");
  exactKeys(value.accounting, ["embeddingRequests", "executedCases", "generativeRequests", "prepareCalls"], "trial accounting");
  exactKeys(value.index, ["embeddingDimension", "files", "schemaVersion", "sidecarBytes"], "trial index");
  if (value.schemaVersion !== TRIAL_SCHEMA_VERSION || value.modelTag !== modelTag || value.trial !== trial) throw new Error("trial identity mismatch");
  if (value.accounting.executedCases !== 60 || value.accounting.prepareCalls !== 60 || value.accounting.generativeRequests !== 0 || !Number.isInteger(value.accounting.embeddingRequests) || value.accounting.embeddingRequests < 120) throw new Error("trial accounting mismatch");
  if (value.index.schemaVersion !== 2 || value.index.files !== 60 || value.index.embeddingDimension <= 0 || value.index.sidecarBytes !== value.index.files * value.index.embeddingDimension * Float32Array.BYTES_PER_ELEMENT) throw new Error("v2 index/sidecar mismatch");
  if (value.verdicts.length !== 60 || value.verdictHash !== sha256(jsonBytes(value.verdicts))) throw new Error("trial verdict hash mismatch");
  for (let index = 0; index < value.verdicts.length; index += 1) {
    const verdict = value.verdicts[index];
    exactKeys(verdict, ["caseId", "category", "ok", "reasonCode"], "terminal verdict");
    const expected = RECALL_FRESHNESS_DATASET.cases[index];
    if (verdict.caseId !== expected.caseId || verdict.category !== expected.category || typeof verdict.ok !== "boolean" || (verdict.ok ? verdict.reasonCode !== null : !REASON_CODES.includes(verdict.reasonCode))) throw new Error("terminal verdict mismatch");
  }
  return value;
}

export function aggregateProductionModel(preflight, trials) {
  if (trials.length !== 2 || trials[0].verdictHash !== trials[1].verdictHash) throw new Error("pass^2 verdict hash mismatch");
  const verdicts = trials[0].verdicts;
  const metrics = ["ordinary-positive", "absent", "correction-pair"].map((category) => {
    const rows = verdicts.filter((item) => item.category === category);
    const passed = rows.filter((item) => item.ok).length;
    const metric = { category, passed, rate: rate(passed, rows.length), total: rows.length };
    return category === "correction-pair"
      ? { ...metric, currentTop1: passed, pairRetained: rows.filter((item) => item.reasonCode !== "PAIR_MISSING").length }
      : metric;
  });
  return {
    digest: preflight.digest,
    dimension: preflight.dimension,
    failedCases: verdicts.filter((item) => !item.ok).map(({ caseId, category, reasonCode }) => ({ caseId, category, reasonCode })),
    metrics,
    modelTag: preflight.modelTag,
    reliable: true,
    resolvedTag: preflight.resolvedTag,
    trialEmbeddingRequests: trials.map((item) => item.accounting.embeddingRequests),
    trialVerdictHash: trials[0].verdictHash
  };
}

export function buildProductionResult({ models, runMetadata, runtimeSources }) {
  const complete = models.length === ALLOWLISTED_MODELS.length && canonicalJson(models.map((item) => item.modelTag)) === canonicalJson(ALLOWLISTED_MODELS);
  const payload = {
    accounting: {
      corpusEntries: 60,
      executedCaseTrials: models.length * 120,
      generativeRequests: 0,
      successfulModelTrials: models.length * 2,
      totalEmbeddingRequests: models.reduce((sum, model) => sum + model.trialEmbeddingRequests.reduce((a, b) => a + b, 0), 0)
    },
    dataset: {
      cases: 60,
      categories: { absent: 20, correction: 20, ordinary: 20 },
      corpusSha256: corpusSha256(),
      dataOrigin: "synthetic frozen v1",
      datasetSha256: datasetSha256(),
      datasetVersion: DATASET_VERSION,
      heldOut: false,
      organicEvidence: false
    },
    executionStatus: complete ? "COMPLETE" : "UNVERIFIED",
    models,
    productionConfig: {
      indexSchemaVersion: 2,
      refineChunks: REFINE_CHUNKS,
      seam: "packages/recall/dist/index.js#prepareGroundedRecall",
      topK: CLI_TOP_K
    },
    runtimeSources,
    scorerVersion: PRODUCTION_SCORER_VERSION
  };
  return { payload, payloadHash: sha256(jsonBytes(payload)), runMetadata, schemaVersion: RESULT_SCHEMA_VERSION };
}

function scanTracked(value, path = "") {
  if (Array.isArray(value)) return value.forEach((item, index) => scanTracked(item, `${path}/${index}`));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/prompt|output|trace|free.?text/iu.test(key)) throw new Error(`forbidden tracked field ${path}/${key}`);
      scanTracked(child, `${path}/${key}`);
    }
    return;
  }
  if (typeof value === "string" && (/\/Users\//iu.test(value) || /\/home\//iu.test(value) || /\.muse/iu.test(value) || /jinan/iu.test(value) || /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_\-]{8,}|ghp_[A-Za-z0-9_\-]{8,}|github_pat_[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9_\-]{8,}|AKIA[A-Z0-9]{12,})/u.test(value))) throw new Error(`private token in tracked aggregate ${path}`);
}

export function validateProductionResult(result) {
  exactKeys(result, ["payload", "payloadHash", "runMetadata", "schemaVersion"], "result");
  exactKeys(result.payload, ["accounting", "dataset", "executionStatus", "models", "productionConfig", "runtimeSources", "scorerVersion"], "payload");
  exactKeys(result.runMetadata, ["generatedAt", "node", "ollamaVersion", "platform"], "run metadata");
  exactKeys(result.payload.accounting, ["corpusEntries", "executedCaseTrials", "generativeRequests", "successfulModelTrials", "totalEmbeddingRequests"], "accounting");
  exactKeys(result.payload.dataset, ["cases", "categories", "corpusSha256", "dataOrigin", "datasetSha256", "datasetVersion", "heldOut", "organicEvidence"], "dataset");
  exactKeys(result.payload.productionConfig, ["indexSchemaVersion", "refineChunks", "seam", "topK"], "production config");
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION || result.payloadHash !== sha256(jsonBytes(result.payload)) || result.payload.executionStatus !== "COMPLETE") throw new Error("canonical result hash/version mismatch");
  if (canonicalJson(result.payload.productionConfig) !== canonicalJson({ indexSchemaVersion: 2, refineChunks: true, seam: "packages/recall/dist/index.js#prepareGroundedRecall", topK: 3 })) throw new Error("production seam/config drift");
  if (result.payload.dataset.datasetSha256 !== datasetSha256() || result.payload.dataset.corpusSha256 !== corpusSha256() || result.payload.dataset.cases !== 60 || result.payload.dataset.heldOut !== false || result.payload.dataset.organicEvidence !== false || result.payload.dataset.dataOrigin !== "synthetic frozen v1") throw new Error("dataset provenance drift");
  if (result.payload.accounting.corpusEntries !== 60 || result.payload.accounting.executedCaseTrials !== 480 || result.payload.accounting.generativeRequests !== 0 || result.payload.accounting.successfulModelTrials !== 8 || !Number.isInteger(result.payload.accounting.totalEmbeddingRequests) || result.payload.accounting.totalEmbeddingRequests <= 0) throw new Error("result accounting mismatch");
  if (canonicalJson(result.payload.models.map((item) => item.modelTag)) !== canonicalJson(ALLOWLISTED_MODELS)) throw new Error("model allowlist/order mismatch");
  if (canonicalJson(result.payload.runtimeSources.map((item) => item.path)) !== canonicalJson(RUNTIME_SOURCE_PATHS)) throw new Error("runtime source order/path drift");
  for (const source of result.payload.runtimeSources) {
    exactKeys(source, ["path", "sha256"], "runtime source");
    if (!/^[a-f0-9]{64}$/u.test(source.sha256)) throw new Error("runtime source hash mismatch");
  }
  for (const model of result.payload.models) {
    exactKeys(model, ["digest", "dimension", "failedCases", "metrics", "modelTag", "reliable", "resolvedTag", "trialEmbeddingRequests", "trialVerdictHash"], `model ${model.modelTag}`);
    if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(model.digest) || !Number.isInteger(model.dimension) || model.dimension <= 0 || model.reliable !== true || !/^[a-f0-9]{64}$/u.test(model.trialVerdictHash) || model.trialEmbeddingRequests.length !== 2 || model.trialEmbeddingRequests.some((item) => !Number.isInteger(item) || item < 120)) throw new Error("model provenance/reliability mismatch");
    if (model.metrics.length !== 3 || canonicalJson(model.metrics.map((item) => item.category)) !== canonicalJson(["ordinary-positive", "absent", "correction-pair"])) throw new Error("metric category/order mismatch");
    const failedIds = new Set();
    const failureCounts = new Map();
    let pairMissing = 0;
    for (const failure of model.failedCases) {
      exactKeys(failure, ["caseId", "category", "reasonCode"], "failed case");
      const testCase = RECALL_FRESHNESS_DATASET.cases.find((item) => item.caseId === failure.caseId && item.category === failure.category);
      const allowedByCategory = {
        absent: ["ABSENT_CONFIDENT"],
        "correction-pair": ["DISTRACTOR_TOP1", "PAIR_MISSING", "STALE_TOP1"],
        "ordinary-positive": ["NOT_CONFIDENT", "WRONG_TOP1"]
      };
      if (!testCase || failedIds.has(failure.caseId) || !allowedByCategory[failure.category]?.includes(failure.reasonCode)) throw new Error("failed-case reason/source drift");
      failedIds.add(failure.caseId);
      failureCounts.set(failure.category, (failureCounts.get(failure.category) ?? 0) + 1);
      if (failure.reasonCode === "PAIR_MISSING") pairMissing += 1;
    }
    for (const metric of model.metrics) {
      if (metric.total !== 20 || !Number.isInteger(metric.passed) || metric.passed < 0 || metric.passed > 20 || metric.rate !== rate(metric.passed, metric.total)) throw new Error("metric reconciliation mismatch");
      if (metric.category === "correction-pair" && (metric.currentTop1 !== metric.passed || !Number.isInteger(metric.pairRetained) || metric.pairRetained < metric.currentTop1 || metric.pairRetained > 20)) throw new Error("correction metric mismatch");
      if (metric.passed !== metric.total - (failureCounts.get(metric.category) ?? 0)) throw new Error("failed-case reconciliation mismatch");
      if (metric.category === "correction-pair" && metric.pairRetained !== metric.total - pairMissing) throw new Error("failed-case reconciliation mismatch");
    }
  }
  scanTracked(result);
  return result;
}

function csvEscape(value) { const text = String(value); return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function renderCsv(result) {
  const fields = ["modelTag", "digest", "category", "passed", "total", "rate", "pairRetained", "currentTop1", "executionStatus"];
  const rows = result.payload.models.flatMap((model) => model.metrics.map((metric) => ({ ...metric, digest: model.digest, executionStatus: result.payload.executionStatus, modelTag: model.modelTag })));
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvEscape(row[field] ?? "")).join(",")).join("\n")}\n`;
}
export function renderMarkdown(result) {
  const lines = [
    "# Recall production-path evaluation",
    "",
    "**COMPLETE** — local-live execution through `packages/recall/dist#prepareGroundedRecall`; zero generative requests.",
    "",
    "| Model | Ordinary confident + correct | Absent abstention | Correction pair retained | Correction current top-1 |",
    "| --- | ---: | ---: | ---: | ---: |"
  ];
  for (const model of result.payload.models) {
    const ordinary = model.metrics[0]; const absent = model.metrics[1]; const correction = model.metrics[2];
    lines.push(`| ${model.modelTag} | ${ordinary.passed}/20 | ${absent.passed}/20 | ${correction.pairRetained}/20 | ${correction.currentTop1}/20 |`);
  }
  lines.push(
    "",
    "Production configuration: CLI default `topK=3`, `refineChunks=true`, real note files, v2 JSON + Float32 sidecar, two identical-condition trials per model.",
    "",
    "Frozen synthetic v1 is not held-out or organic evidence. Repeats are collapsed. This does not improve the 10/11 agent aggregate.",
    "",
    "**agent capability remains aggregate FAILED · organic effectiveness = NOT_PROVEN · generative requests = 0**",
    ""
  );
  return lines.join("\n");
}
function escapeXml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
export function renderSvg(result) {
  const rows = result.payload.models.map((model, index) => {
    const y = 135 + index * 100; const ordinary = model.metrics[0]; const absent = model.metrics[1]; const correction = model.metrics[2];
    const bars = [ordinary.passed, absent.passed, correction.pairRetained, correction.currentTop1];
    return `<text x="35" y="${y}" class="model">${escapeXml(model.modelTag)}</text>${bars.map((value, bar) => `<rect x="310" y="${y - 14 + bar * 18}" width="${value * 25}" height="12" rx="3" class="b${bar}"/><text x="${320 + value * 25}" y="${y - 4 + bar * 18}" class="value">${value}/20</text>`).join("")}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600" viewBox="0 0 1000 600" role="img" aria-labelledby="title desc"><title id="title">Recall production-path evaluation</title><desc id="desc">Ordinary correctness and confidence, absent abstention, correction pair retention, and current top-one results for four local embedders through the production prepareGroundedRecall seam.</desc><style>text{font-family:Inter,ui-sans-serif,system-ui,sans-serif;fill:#172033}.title{font-size:25px;font-weight:760}.sub{font-size:12px;fill:#536075}.model{font-size:13px;font-weight:650}.value{font-size:10px}.b0{fill:#2563eb}.b1{fill:#0891b2}.b2{fill:#d97706}.b3{fill:#7c3aed}</style><rect width="1000" height="600" fill="#fff"/><text x="35" y="42" class="title">Recall production-path · ${result.payload.executionStatus}</text><text x="35" y="68" class="sub">topK 3 · refineChunks true · frozen synthetic v1 · four models × pass² · generative requests 0</text><text x="310" y="96" class="sub">blue ordinary · cyan absent · amber pair retained · purple current top-1</text>${rows}<text x="35" y="560" class="sub">agent aggregate FAILED · organic effectiveness NOT_PROVEN · repeats collapsed</text></svg>\n`;
}

export async function validateArtifacts(paths = trackedPaths) {
  const bytes = await readFile(paths.json, "utf8");
  if (!bytes.endsWith("\n")) throw new Error("canonical JSON must end with LF");
  const result = validateProductionResult(JSON.parse(bytes));
  if (bytes !== jsonBytes(result)) throw new Error("canonical JSON bytes mismatch");
  if (canonicalJson(result.payload.runtimeSources) !== canonicalJson(await runtimeSourceProvenance())) throw new Error("production runtime source drift");
  const expected = { csv: renderCsv(result), md: renderMarkdown(result), svg: renderSvg(result) };
  for (const key of ["csv", "md", "svg"]) if (await readFile(paths[key], "utf8") !== expected[key]) throw new Error(`${key.toUpperCase()} does not reconcile with canonical JSON`);
  return result;
}

async function createProductionFixture({ embed, home, modelTag }) {
  const { embeddingsSidecarPath, loadIndex, prepareGroundedRecall, reindexNotes } = await import("../packages/recall/dist/index.js");
  const notesDir = join(home, ".muse", "notes");
  const indexPath = join(home, ".muse", "notes-index.json");
  await mkdir(notesDir, { recursive: true });
  const pathToSource = new Map();
  for (const item of RECALL_FRESHNESS_DATASET.corpus) {
    const path = resolve(notesDir, sourceFilename(item.source));
    pathToSource.set(path, item.source);
    await writeFile(path, `${item.text}\n`, { mode: 0o600 });
  }
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ embedding: await embed(body.prompt, body.model) }), { headers: { "content-type": "application/json" }, status: 200 });
  };
  const summary = await reindexNotes({ dir: notesDir, fetchImpl, force: true, indexPath, model: modelTag });
  const loaded = await loadIndex(indexPath);
  const sidecar = await stat(embeddingsSidecarPath(indexPath));
  if (!loaded || summary.failed !== 0 || summary.embedded !== 60 || loaded.files.length !== 60) throw new Error("production v2 index creation failed");
  const firstEmbedding = loaded.files[0]?.chunks[0]?.embedding;
  if (!firstEmbedding || firstEmbedding.length === 0) throw new Error("production v2 index has no embeddings");
  return {
    index: { embeddingDimension: firstEmbedding.length, files: loaded.files.length, schemaVersion: loaded.version, sidecarBytes: sidecar.size },
    indexPath,
    notesDir,
    prepare: prepareGroundedRecall,
    sourceForFile: (file) => pathToSource.get(resolve(file)) ?? null
  };
}

async function childPreflight({ baseUrl, modelTag, outputPath }) {
  const { createOllamaEmbedder } = await import("../packages/autoconfigure/dist/index.js");
  const [versionResponse, tagsResponse] = await Promise.all([
    fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) })
  ]);
  if (!versionResponse.ok || !tagsResponse.ok) throw new Error("OLLAMA_UNREACHABLE");
  const version = await versionResponse.json(); const tags = await tagsResponse.json();
  const acceptedTags = modelTag.includes(":") ? [modelTag] : [modelTag, `${modelTag}:latest`];
  const found = Array.isArray(tags.models) ? tags.models.find((item) => acceptedTags.includes(item.name) || acceptedTags.includes(item.model)) : undefined;
  if (!found) throw new Error("MODEL_MISSING");
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(found.digest)) throw new Error("DIGEST_MISSING");
  const vector = await createOllamaEmbedder(modelTag, { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl })("synthetic production-path preflight probe");
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((item) => !Number.isFinite(item))) throw new Error("INVALID_VECTOR");
  await writeAtomic(outputPath, jsonBytes({ digest: found.digest, dimension: vector.length, modelTag, ollamaVersion: String(version.version ?? ""), resolvedTag: String(found.model ?? found.name) }));
}

async function childTrial({ baseUrl, modelTag, outputPath, trial }) {
  const { createOllamaEmbedder } = await import("../packages/autoconfigure/dist/index.js");
  const rawEmbed = createOllamaEmbedder(modelTag, { MUSE_LOCAL_ONLY: "true", OLLAMA_BASE_URL: baseUrl });
  let embeddingRequests = 0;
  const embed = async (text, model = modelTag) => { embeddingRequests += 1; return rawEmbed(text, model); };
  const home = process.env.HOME;
  if (!home || !process.env.TMPDIR?.startsWith(home)) throw new Error("trial HOME/TMPDIR isolation missing");
  const fixture = await createProductionFixture({ embed, home, modelTag });
  const result = await executeProductionTrial({ embedFn: embed, indexPath: fixture.indexPath, modelTag, notesDir: fixture.notesDir, prepare: fixture.prepare, sourceForFile: fixture.sourceForFile, trial });
  const complete = { ...result, accounting: { ...result.accounting, embeddingRequests, generativeRequests: 0 }, index: fixture.index };
  validateProductionTrial(complete, modelTag, trial);
  await writeAtomic(outputPath, jsonBytes(complete));
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

async function runModelChildren(modelTag, baseUrl, sessionDir) {
  const safe = safeModelName(modelTag);
  const preflightHome = join(sessionDir, "homes", safe, "preflight");
  await mkdir(join(preflightHome, "tmp"), { recursive: true });
  const preflightPath = join(sessionDir, `${safe}-preflight.json`);
  const preflightRun = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child-preflight", "1", "--model", modelTag, "--out", preflightPath], { env: scrubbedEnv(baseUrl, preflightHome), outputPath: preflightPath, timeoutMs: PREFLIGHT_TIMEOUT_MS });
  if (!preflightRun.ok) return preflightRun;
  let preflight;
  try {
    preflight = JSON.parse(await readFile(preflightPath, "utf8"));
    exactKeys(preflight, ["digest", "dimension", "modelTag", "ollamaVersion", "resolvedTag"], "preflight");
    if (preflight.modelTag !== modelTag || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(preflight.digest) || !Number.isInteger(preflight.dimension) || preflight.dimension <= 0 || !preflight.ollamaVersion || !preflight.resolvedTag) throw new Error("preflight provenance mismatch");
  } catch { return { ok: false, reasonCode: "INVALID_VECTOR" }; }
  const trials = [];
  for (let trial = 1; trial <= 2; trial += 1) {
    const home = join(sessionDir, "homes", safe, `trial-${trial}`);
    await mkdir(join(home, "tmp"), { recursive: true });
    const path = join(sessionDir, `${safe}-trial-${trial}.json`);
    const run = await spawnWithTimeout(process.execPath, [fileURLToPath(import.meta.url), "--child-trial", "1", "--model", modelTag, "--out", path, "--trial", String(trial)], { env: scrubbedEnv(baseUrl, home), outputPath: path, timeoutMs: CHILD_TIMEOUT_MS });
    if (!run.ok) return run;
    try { trials.push(validateProductionTrial(JSON.parse(await readFile(path, "utf8")), modelTag, trial)); }
    catch { return { ok: false, reasonCode: "COUNT_MISMATCH" }; }
  }
  try { return { model: aggregateProductionModel(preflight, trials), ok: true, ollamaVersion: preflight.ollamaVersion }; }
  catch { return { ok: false, reasonCode: "HASH_MISMATCH" }; }
}

async function promoteTracked(result) {
  validateProductionResult(result);
  const stage = join(diagnosticsRoot, `stage-${process.pid}`);
  await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
  const paths = { csv: join(stage, "result.csv"), json: join(stage, "result.json"), md: join(stage, "result.md"), svg: join(stage, "result.svg") };
  await writeAtomic(paths.json, jsonBytes(result)); await writeAtomic(paths.csv, renderCsv(result)); await writeAtomic(paths.md, renderMarkdown(result)); await writeAtomic(paths.svg, renderSvg(result));
  await validateArtifacts(paths);
  for (const key of ["csv", "md", "svg", "json"]) await rename(paths[key], trackedPaths[key]);
  await rm(stage, { recursive: true, force: true }); await validateArtifacts();
}

async function parentMain(smokeModel) {
  const { detectStaleMarker } = await import("../packages/recall/dist/index.js");
  validateDataset(RECALL_FRESHNESS_DATASET, detectStaleMarker);
  const baseUrl = canonicalLocalBaseUrl(process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434");
  const models = smokeModel ? [smokeModel] : [...ALLOWLISTED_MODELS];
  if (models.some((model) => !ALLOWLISTED_MODELS.includes(model))) throw new Error("model is not allowlisted");
  const sessionDir = join(diagnosticsRoot, new Date().toISOString().replaceAll(/[:.]/gu, "-"));
  await mkdir(sessionDir, { recursive: true });
  const completed = []; const diagnostics = [];
  for (const modelTag of models) {
    const outcome = await runModelChildren(modelTag, baseUrl, sessionDir);
    diagnostics.push({ modelTag, ok: outcome.ok, reasonCode: outcome.ok ? null : outcome.reasonCode });
    if (outcome.ok) completed.push(outcome);
  }
  await writeAtomic(join(sessionDir, "summary.json"), jsonBytes({ diagnostics, requestedModels: models }));
  if (completed.length !== models.length) throw new Error(`UNVERIFIED ${canonicalJson(diagnostics)}`);
  if (smokeModel) {
    const model = completed[0].model;
    process.stdout.write(`${canonicalJson({ metrics: model.metrics, model: smokeModel, status: "SMOKE_PASS", trials: 2 })}\n`);
    return;
  }
  const versions = new Set(completed.map((item) => item.ollamaVersion));
  if (versions.size !== 1) throw new Error("UNVERIFIED Ollama version changed");
  const result = buildProductionResult({ models: completed.map((item) => item.model), runMetadata: { generatedAt: new Date().toISOString(), node: process.version, ollamaVersion: [...versions][0], platform: `${process.platform}/${process.arch}` }, runtimeSources: await runtimeSourceProvenance() });
  await promoteTracked(result);
  process.stdout.write(`${canonicalJson({ artifact: trackedPaths.json, status: result.payload.executionStatus })}\n`);
}

async function main() {
  const args = normalizeCliArgs(process.argv.slice(2));
  if (args[0] === "--validate") {
    if (args.length !== 1) throw new Error("validate takes no options");
    const result = await validateArtifacts(); process.stdout.write(`${canonicalJson({ payloadHash: result.payloadHash, status: result.payload.executionStatus })}\n`); return;
  }
  if (args[0] === "--child-preflight" || args[0] === "--child-trial") {
    const mode = args[0]; const options = parseInternalArgs(args.slice(2)); const baseUrl = canonicalLocalBaseUrl(process.env.OLLAMA_BASE_URL);
    if (!options.model || !options.out) throw new Error("missing child options");
    if (mode === "--child-preflight") await childPreflight({ baseUrl, modelTag: options.model, outputPath: options.out });
    else await childTrial({ baseUrl, modelTag: options.model, outputPath: options.out, trial: Number(options.trial) });
    return;
  }
  if (args.length === 0) return parentMain();
  if (args.length === 2 && args[0] === "--smoke-model") return parentMain(args[1]);
  throw new Error("Usage: eval-recall-production-path.mjs [--smoke-model <allowlisted-model>|--validate]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
