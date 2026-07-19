import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOWLISTED_MODELS,
  ARMS,
  CATEGORIES,
  RANK_OPTIONS,
  RECALL_FRESHNESS_DATASET,
  aggregateModel,
  buildCanonicalResult,
  canonicalJson,
  canonicalLocalBaseUrl,
  datasetSha256,
  evaluateCaseWithArms,
  executeTrial,
  normalizeCliArgs,
  renderCsv,
  renderMarkdown,
  renderSvg,
  resolveBenchmarkStatus,
  sha256,
  spawnWithTimeout,
  validateArtifacts,
  validateCanonicalResult,
  validateDataset,
  validatePreflight
} from "./eval-recall-freshness-ablation.mjs";

const roots = [];
async function tempRoot() { const root = await mkdtemp(join(tmpdir(), "muse-recall-ablation-test-")); roots.push(root); return root; }
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("dataset is balanced, unique, immutable, and matches Muse stale markers", async () => {
  const conflictSource = await readFile(new URL("../packages/recall/src/conflict.ts", import.meta.url), "utf8");
  assert.match(conflictSource, /\/예전에\/u/); assert.match(conflictSource, /used to/);
  assert.equal(validateDataset(RECALL_FRESHNESS_DATASET, (text) => /예전에/u.test(text) || /\bused to\b/iu.test(text)), true);
  assert.equal(RECALL_FRESHNESS_DATASET.cases.length, 60);
  assert.equal(RECALL_FRESHNESS_DATASET.corpus.length, 60);
  assert.match(datasetSha256(), /^[a-f0-9]{64}$/u);
  for (const category of CATEGORIES) for (const locale of ["ko", "en"]) {
    const cases = RECALL_FRESHNESS_DATASET.cases.filter((item) => item.category === category && item.locale === locale);
    assert.equal(cases.length, 10); assert.ok(new Set(cases.map((item) => item.domain)).size >= 5);
  }
});

test("both arms share one raw result and use the identical terminal scorer", () => {
  const testCase = RECALL_FRESHNESS_DATASET.cases.find((item) => item.category === "correction-pair"); const raw = [
    { cosine: 0.8, score: 1, source: testCase.staleSource, text: "stale" },
    { cosine: 0.79, score: 0.9, source: testCase.currentSource, text: "current" }
  ];
  let demoteInput; const verdicts = evaluateCaseWithArms(testCase, raw, { classify: () => "confident", confidentAt: 0.55, demote: (items) => { demoteInput = items; return [items[1], items[0]]; } });
  assert.equal(demoteInput, raw); assert.deepEqual(verdicts.map((item) => [item.arm, item.ok, item.reasonCode]), [["raw-retrieval", false, "STALE_TOP1"], ["muse-freshness", true, null]]);
});

test("terminal scorer rejects pair-missing and adversarial distractor top-1", () => {
  const testCase = RECALL_FRESHNESS_DATASET.cases.find((item) => item.category === "correction-pair"); const classify = () => "confident";
  const missing = evaluateCaseWithArms(testCase, [{ cosine: 1, score: 1, source: testCase.currentSource, text: "current" }], { classify, confidentAt: 0.55, demote: (items) => [...items] });
  assert.ok(missing.every((item) => item.reasonCode === "PAIR_MISSING"));
  const distractor = { cosine: 1, score: 1, source: "syn:distractor", text: "distractor" }; const pair = [{ cosine: 0.9, score: 0.9, source: testCase.currentSource, text: "current" }, { cosine: 0.8, score: 0.8, source: testCase.staleSource, text: "stale" }];
  const observed = evaluateCaseWithArms(testCase, [distractor, ...pair], { classify, confidentAt: 0.55, demote: (items) => [...items] }); assert.ok(observed.every((item) => item.reasonCode === "DISTRACTOR_TOP1"));
});

test("one trial makes 60 raw calls and exactly 120 memoized embedding requests", async () => {
  let rankCalls = 0; const result = await executeTrial({ classify: () => "ambiguous", confidentAt: 0.55, demote: (items) => [...items], embed: async (text) => [text.length, 1], modelTag: ALLOWLISTED_MODELS[0], trial: 1,
    rank: async (query, corpus, options) => { rankCalls += 1; assert.deepEqual(Object.fromEntries(Object.entries(options).filter(([key]) => key !== "embed")), RANK_OPTIONS); await options.embed(query); for (const item of corpus) await options.embed(item.text); return []; }
  });
  assert.equal(rankCalls, 60); assert.deepEqual(result.accounting, { armVerdicts: 120, benchmarkEmbeddingRequests: 120, executedCases: 60, rawRankCalls: 60 });
});

function passingTrials(modelTag) {
  const verdicts = RECALL_FRESHNESS_DATASET.cases.flatMap((item) => ARMS.map((arm) => {
    const rawCorrection = item.category === "correction-pair" && arm === "raw-retrieval";
    return { arm, caseId: item.caseId, category: item.category, ok: !rawCorrection, reasonCode: rawCorrection ? "STALE_TOP1" : null };
  }));
  const verdictHash = sha256(`${canonicalJson(verdicts)}\n`); return [1, 2].map((trial) => ({ accounting: { armVerdicts: 120, benchmarkEmbeddingRequests: 120, executedCases: 60, rawRankCalls: 60 }, modelTag, schemaVersion: "muse-recall-freshness-child.v1", trial, verdictHash, verdicts }));
}
function completeResult() {
  const models = ALLOWLISTED_MODELS.map((modelTag, index) => aggregateModel({ calibrated: index < 2, confidentAt: index === 1 ? 0.45 : 0.55, digest: `${String(index + 1).repeat(64).slice(0, 64)}`, dimension: 768 + index, modelTag, resolvedTag: modelTag }, passingTrials(modelTag)));
  return buildCanonicalResult({ models, runMetadata: { generatedAt: "2030-01-01T00:00:00.000Z", node: "v24.0.0", ollamaVersion: "0.99.0", platform: "darwin/arm64" } });
}

test("repeat hashes, per-category non-regression, and status priority fail closed", () => {
  const result = completeResult(); assert.equal(result.payload.status, "IMPROVED"); assert.equal(validateCanonicalResult(result), result);
  const trials = passingTrials(ALLOWLISTED_MODELS[0]); trials[1] = { ...trials[1], verdictHash: "0".repeat(64) }; assert.throws(() => aggregateModel({ modelTag: ALLOWLISTED_MODELS[0] }, trials), /hash mismatch/);
  assert.equal(resolveBenchmarkStatus({ complete: false, models: [] }), "UNVERIFIED");
  assert.equal(resolveBenchmarkStatus({ complete: true, models: [{ reliable: true, correctionDelta: -0.1, categoryNonRegression: { absent: true } }] }), "REGRESSED");
  assert.equal(resolveBenchmarkStatus({ complete: true, models: [{ reliable: true, correctionDelta: 0, categoryNonRegression: { absent: true } }] }), "UNCHANGED");
});

test("preflight rejects unavailable provenance and invalid vectors/digests; remote URLs fail before requests", () => {
  const base = { digest: "a".repeat(64), dimension: 768, modelTag: ALLOWLISTED_MODELS[0], ollamaVersion: "1", preflightEmbeddingRequests: 1, resolvedTag: `${ALLOWLISTED_MODELS[0]}:latest`, schemaVersion: "muse-recall-freshness-child.v1" };
  assert.equal(validatePreflight(base, ALLOWLISTED_MODELS[0]), base);
  assert.throws(() => validatePreflight({ ...base, digest: "" }, ALLOWLISTED_MODELS[0]), /digest/);
  assert.throws(() => validatePreflight({ ...base, dimension: 0 }, ALLOWLISTED_MODELS[0]), /vector/);
  assert.throws(() => canonicalLocalBaseUrl("https://example.com:11434"), /loopback/);
  assert.equal(canonicalLocalBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(canonicalLocalBaseUrl("http://[::1]:11434"), "http://[::1]:11434");
});

test("pnpm's literal option separator is ignored without changing benchmark options", () => {
  assert.deepEqual(normalizeCliArgs(["--", "--smoke-model", "nomic-embed-text"]), ["--smoke-model", "nomic-embed-text"]);
  assert.deepEqual(normalizeCliArgs([]), []);
});

test("child timeout and missing output cannot become accepted evidence", async () => {
  const root = await tempRoot(); const timeout = await spawnWithTimeout(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { env: process.env, outputPath: join(root, "timeout.json"), timeoutMs: 20 }); assert.deepEqual(timeout, { ok: false, reasonCode: "TIMEOUT" });
  const partial = await spawnWithTimeout(process.execPath, ["-e", "process.exit(0)"], { env: process.env, outputPath: join(root, "partial.json"), timeoutMs: 1_000 }); assert.deepEqual(partial, { ok: false, reasonCode: "PARTIAL_OUTPUT" });
});

test("canonical JSON is the only truth for CSV, MD, and SVG and rejects private/free-text fields", async () => {
  const result = completeResult(); const root = await tempRoot(); const paths = { json: join(root, "result.json"), csv: join(root, "result.csv"), md: join(root, "result.md"), svg: join(root, "result.svg") };
  await writeFile(paths.json, `${canonicalJson(result)}\n`); await writeFile(paths.csv, renderCsv(result)); await writeFile(paths.md, renderMarkdown(result)); await writeFile(paths.svg, renderSvg(result)); assert.equal((await validateArtifacts(paths)).payload.status, "IMPROVED");
  assert.match(await readFile(paths.md, "utf8"), /Pair retained in raw top-4/); assert.match(await readFile(paths.md, "utf8"), /PAIR_MISSING/);
  const svg = await readFile(paths.svg, "utf8"); for (const token of [...ALLOWLISTED_MODELS, ...ARMS, ...CATEGORIES, "NOT_PROVEN", "NOT_RUN"]) assert.match(svg, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(svg, /height="770" viewBox="0 0 1200 770"/u); assert.match(svg, />Legend</u); assert.match(svg, /<text x="40" y="718" class="footer">/u);
  await writeFile(paths.csv, `${renderCsv(result)}corrupt\n`); await assert.rejects(validateArtifacts(paths), /CSV/); await rm(paths.csv); await assert.rejects(validateArtifacts(paths), /ENOENT/);
  const privateResult = structuredClone(result); privateResult.payload.prompt = "private"; privateResult.payloadHash = sha256(`${canonicalJson(privateResult.payload)}\n`); assert.throws(() => validateCanonicalResult(privateResult), /fields mismatch|forbidden/);
});

test("evidence index and README preserve qualified links and 10/11 boundary", async () => {
  const [readme, evidence] = await Promise.all([readFile(new URL("../README.md", import.meta.url), "utf8"), readFile(new URL("../docs/benchmarks/EVIDENCE.md", import.meta.url), "utf8")]);
  for (const text of [readme, evidence]) { assert.match(text, /recall-freshness-ablation/iu); assert.match(text, /local-live retrieval component/iu); assert.match(text, /NOT_PROVEN/u); }
  assert.match(readme, /10\/11/); assert.match(readme, /test counts.*not.*agent-effect proof/iu); assert.match(evidence, /software assurance/iu); assert.match(evidence, /organic personal effectiveness/iu);
  assert.match(readme, /UNCHANGED.*four.*delta 0/iu); assert.match(evidence, /8\/80/); assert.match(evidence, /controlled local-model component/iu);
});
