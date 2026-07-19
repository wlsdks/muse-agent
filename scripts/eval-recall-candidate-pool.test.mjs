import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWLISTED_MODELS, RECALL_FRESHNESS_DATASET, canonicalJson, canonicalLocalBaseUrl, datasetSha256, sha256 } from "./eval-recall-freshness-ablation.mjs";
import {
  CHILD_SCHEMA_VERSION,
  RANK_OPTIONS_BASE,
  TOP4_BASELINE,
  TOP_K,
  aggregateCandidateModel,
  buildCandidateResult,
  corpusSha256,
  executeCandidateTrial,
  normalizeCliArgs,
  readAcceptedBaseline,
  renderCsv,
  renderMarkdown,
  renderSvg,
  spawnWithTimeout,
  validateArtifacts,
  validateCandidatePreflight,
  validateCandidateResult,
  validateCandidateTrial
} from "./eval-recall-candidate-pool.mjs";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function tempRoot() { const root = await mkdtemp(join(tmpdir(), "muse-candidate-pool-test-")); roots.push(root); return root; }
const correctionCases = RECALL_FRESHNESS_DATASET.cases.filter((item) => item.category === "correction-pair");
function verdict(ok, pairRetained) { return { ok, reasonCode: ok ? null : pairRetained ? "STALE_TOP1" : "PAIR_MISSING" }; }
function observationsFor(expectation = { museCurrentTop1: 20, pairRetained: 20, rawCurrentTop1: 20 }) {
  return TOP_K.flatMap((k) => correctionCases.map((item, index) => {
    const pairRetained = k === 4 ? index < expectation.pairRetained : true;
    return { caseId: item.caseId, k, museVerdict: verdict(k === 4 ? index < expectation.museCurrentTop1 : true, pairRetained), pairRetained, rawVerdict: verdict(k === 4 ? index < expectation.rawCurrentTop1 : true, pairRetained) };
  }));
}
function trials(modelTag, expectation) {
  const observations = observationsFor(expectation); const verdictHash = sha256(`${canonicalJson(observations)}\n`);
  return [1, 2].map((trial) => ({ accounting: { armVerdicts: 120, benchmarkEmbeddingRequests: 80, caseKObservations: 60, rawRankCalls: 60 }, modelTag, observations, schemaVersion: CHILD_SCHEMA_VERSION, trial, verdictHash }));
}
function preflight(modelTag, index = 0) { return { calibrated: index < 2, confidentAt: 0.55, digest: String(index + 1).repeat(64).slice(0, 64), dimension: 768 + index, modelTag, ollamaVersion: "0.32.0", preflightEmbeddingRequests: 1, resolvedTag: modelTag, schemaVersion: CHILD_SCHEMA_VERSION }; }

test("accepted freshness baseline pins dataset, corpus, payload, and per-model top-4", async () => {
  const { result } = await readAcceptedBaseline();
  assert.equal(result.payload.dataset.datasetSha256, datasetSha256()); assert.match(corpusSha256(), /^[a-f0-9]{64}$/u);
  assert.equal(RECALL_FRESHNESS_DATASET.corpus.length, 60); assert.equal(correctionCases.length, 20);
  assert.deepEqual(result.payload.models.map((model) => TOP4_BASELINE[model.modelTag].pairRetained), [1, 5, 1, 1]);
});

test("one model-trial shares one 80-text cache across topK and makes exact rank/verdict counts", async () => {
  let rankCalls = 0; const result = await executeCandidateTrial({ classify: () => "confident", confidentAt: 0.55, demote: (items) => [...items], embed: async (text) => [text.length, 1], modelTag: ALLOWLISTED_MODELS[0], trial: 1,
    rank: async (query, corpus, options) => { rankCalls += 1; assert.ok(TOP_K.includes(options.topK)); assert.deepEqual(Object.fromEntries(Object.entries(options).filter(([key]) => !["embed", "topK"].includes(key))), RANK_OPTIONS_BASE); await options.embed(query); for (const item of corpus) await options.embed(item.text); return []; }
  });
  assert.equal(rankCalls, 60); assert.deepEqual(result.accounting, { armVerdicts: 120, benchmarkEmbeddingRequests: 80, caseKObservations: 60, rawRankCalls: 60 });
  assert.deepEqual(result.observations.map((item) => item.k), [...Array(20).fill(4), ...Array(20).fill(8), ...Array(20).fill(12)]);
  assert.equal(validateCandidateTrial(result, ALLOWLISTED_MODELS[0], 1), result);
});

test("pair retention and the shared raw/Muse terminal scorer remain distinct", async () => {
  const result = await executeCandidateTrial({ classify: () => "confident", confidentAt: 0.55, demote: (items) => [items[1], items[0]], embed: async () => [1], modelTag: ALLOWLISTED_MODELS[0], trial: 1,
    rank: async (query) => { const item = correctionCases.find((entry) => entry.query === query); return [{ cosine: 1, score: 1, source: item.staleSource, text: "used to" }, { cosine: 0.9, score: 0.9, source: item.currentSource, text: "current" }]; }
  });
  assert.ok(result.observations.every((item) => item.pairRetained && !item.rawVerdict.ok && item.rawVerdict.reasonCode === "STALE_TOP1" && item.museVerdict.ok));
});

test("trial repeat, count, ordered hash, and accepted topK4 reproduction fail closed", () => {
  const modelTag = ALLOWLISTED_MODELS[0]; const good = trials(modelTag, TOP4_BASELINE[modelTag]);
  const model = aggregateCandidateModel(preflight(modelTag), good); assert.equal(model.metrics[0].pairRetained, 1);
  const mismatched = structuredClone(good); mismatched[1].verdictHash = "0".repeat(64); assert.throws(() => aggregateCandidateModel(preflight(modelTag), mismatched), /hash mismatch/);
  const wrongBaseline = trials(modelTag, { museCurrentTop1: 2, pairRetained: 2, rawCurrentTop1: 2 }); assert.throws(() => aggregateCandidateModel(preflight(modelTag), wrongBaseline), /topK4 baseline/);
  const badCount = structuredClone(good[0]); badCount.accounting.rawRankCalls = 59; assert.throws(() => validateCandidateTrial(badCount, modelTag, 1), /count\/hash/);
});

test("complete canonical result has exact 644/640/480/960 accounting and closed provenance", async () => {
  const baseline = (await readAcceptedBaseline()).result;
  const models = ALLOWLISTED_MODELS.map((modelTag, index) => aggregateCandidateModel(preflight(modelTag, index), trials(modelTag, TOP4_BASELINE[modelTag])));
  const result = buildCandidateResult({ baseline, models, runMetadata: { generatedAt: "2030-01-01T00:00:00.000Z", node: "v24.0.0", ollamaVersion: "0.32.0", platform: "darwin/arm64" } });
  assert.equal(validateCandidateResult(result), result);
  assert.deepEqual(result.payload.accounting, { armVerdicts: 960, benchmarkEmbeddingRequests: 640, caseKTrialObservations: 480, correctionCases: 20, preflightEmbeddingRequests: 4, rawRankCalls: 480, successfulModelTrials: 8, totalEmbeddingRequests: 644 });
  const privateResult = structuredClone(result); privateResult.payload.prompt = "private"; privateResult.payloadHash = sha256(`${canonicalJson(privateResult.payload)}\n`); assert.throws(() => validateCandidateResult(privateResult), /fields mismatch|forbidden/);
});

test("preflight, remote URL, literal pnpm separator, timeout, and partial outputs fail closed", async () => {
  const base = preflight(ALLOWLISTED_MODELS[0]); const child = { digest: base.digest, dimension: base.dimension, modelTag: base.modelTag, ollamaVersion: base.ollamaVersion, preflightEmbeddingRequests: 1, resolvedTag: base.resolvedTag, schemaVersion: CHILD_SCHEMA_VERSION };
  assert.equal(validateCandidatePreflight(child, base.modelTag), child); assert.throws(() => validateCandidatePreflight({ ...child, digest: "" }, base.modelTag), /provenance/);
  assert.throws(() => canonicalLocalBaseUrl("https://example.com:11434"), /loopback/); assert.deepEqual(normalizeCliArgs(["--", "--smoke-model", base.modelTag]), ["--smoke-model", base.modelTag]);
  const root = await tempRoot(); const timeout = await spawnWithTimeout(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { env: process.env, outputPath: join(root, "timeout.json"), timeoutMs: 20 }); assert.deepEqual(timeout, { ok: false, reasonCode: "TIMEOUT" });
  const partial = await spawnWithTimeout(process.execPath, ["-e", "process.exit(0)"], { env: process.env, outputPath: join(root, "partial.json"), timeoutMs: 1_000 }); assert.deepEqual(partial, { ok: false, reasonCode: "PARTIAL_OUTPUT" });
});

test("canonical candidate JSON alone derives CSV, Markdown, and accessible SVG", async () => {
  const baseline = (await readAcceptedBaseline()).result; const models = ALLOWLISTED_MODELS.map((modelTag, index) => aggregateCandidateModel(preflight(modelTag, index), trials(modelTag, TOP4_BASELINE[modelTag]))); const result = buildCandidateResult({ baseline, models, runMetadata: { generatedAt: "2030-01-01T00:00:00.000Z", node: "v24", ollamaVersion: "0.32.0", platform: "darwin/arm64" } }); const root = await tempRoot(); const paths = { csv: join(root, "result.csv"), json: join(root, "result.json"), md: join(root, "result.md"), svg: join(root, "result.svg") };
  await writeFile(paths.json, `${canonicalJson(result)}\n`); await writeFile(paths.csv, renderCsv(result)); await writeFile(paths.md, renderMarkdown(result)); await writeFile(paths.svg, renderSvg(result)); assert.equal((await validateArtifacts(paths)).payload.executionStatus, "COMPLETE");
  const svg = await readFile(paths.svg, "utf8"); assert.match(svg, /<title id="title">/); assert.match(svg, /<desc id="desc">/); assert.match(svg, /NOT_PROVEN/); assert.match(await readFile(paths.md, "utf8"), /zero generative requests/iu);
  assert.match(svg, /raw correction pass/); assert.match(svg, /Muse correction pass/); assert.match(svg, /pass = pair retained \+ current top-1/);
  const markdown = await readFile(paths.md, "utf8"); assert.match(markdown, /Raw correction pass/); assert.match(markdown, /Correction pass = pair retained \+ current top-1/);
  assert.doesNotMatch(svg, /raw current top-1|Muse current top-1/u); assert.doesNotMatch(markdown, /Raw current top-1|Muse current top-1/u);
  await writeFile(paths.csv, `${renderCsv(result)}corrupt\n`); await assert.rejects(validateArtifacts(paths), /CSV/);
});
