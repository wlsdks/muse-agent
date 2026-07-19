import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWLISTED_MODELS, RECALL_FRESHNESS_DATASET, canonicalJson, sha256 } from "./eval-recall-freshness-ablation.mjs";
import {
  TRIAL_SCHEMA_VERSION,
  aggregateProductionModel,
  buildProductionResult,
  executeProductionTrial,
  renderCsv,
  renderMarkdown,
  renderSvg,
  runtimeSourceProvenance,
  scoreProductionCase,
  validateArtifacts,
  validateProductionResult,
  validateProductionTrial
} from "./eval-recall-production-path.mjs";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const scored = (...sources) => ({
  scored: sources.map((source) => ({ file: source })),
  verdict: "confident"
});

test("one trial sends all frozen cases through the production prepare seam with CLI defaults", async () => {
  const byQuery = new Map(RECALL_FRESHNESS_DATASET.cases.map((item) => [item.query, item]));
  const calls = [];
  const embedFn = async () => [1];
  const trial = await executeProductionTrial({
    embedFn,
    indexPath: "/tmp/home/.muse/notes-index.json",
    modelTag: "nomic-embed-text-v2-moe",
    notesDir: "/tmp/home/.muse/notes",
    prepare: async (input) => {
      calls.push(input);
      const item = byQuery.get(input.query);
      if (item.category === "absent") return { scored: [], verdict: "none" };
      if (item.category === "correction-pair") return scored(item.currentSource, item.staleSource);
      return scored(item.expectedSource);
    },
    sourceForFile: (file) => file,
    trial: 1
  });

  assert.equal(calls.length, 60);
  assert.ok(calls.every((input) => input.embedFn === embedFn));
  assert.ok(calls.every((input) => input.options.topK === 3 && input.options.embedModel === "nomic-embed-text-v2-moe"));
  assert.ok(calls.every((input) => input.extras.refineChunks === true));
  assert.ok(calls.every((input) => input.sources.notesDir === "/tmp/home/.muse/notes" && input.sources.notesIndexFile.endsWith("notes-index.json")));
  assert.deepEqual(trial.accounting, { executedCases: 60, prepareCalls: 60 });
  assert.equal(trial.verdicts.length, 60);
  assert.ok(trial.verdicts.every((item) => item.ok));
});

function completeTrial(modelTag, trial) {
  const verdicts = RECALL_FRESHNESS_DATASET.cases.map((item) => ({ caseId: item.caseId, category: item.category, ok: true, reasonCode: null }));
  return {
    accounting: { embeddingRequests: 180, executedCases: 60, generativeRequests: 0, prepareCalls: 60 },
    index: { embeddingDimension: 3, files: 60, schemaVersion: 2, sidecarBytes: 720 },
    modelTag,
    schemaVersion: TRIAL_SCHEMA_VERSION,
    trial,
    verdictHash: sha256(`${canonicalJson(verdicts)}\n`),
    verdicts
  };
}

test("pass^2, production config, canonical derivatives, drift, and private-text mutations fail closed", async () => {
  const models = ALLOWLISTED_MODELS.map((modelTag, index) => {
    const trials = [completeTrial(modelTag, 1), completeTrial(modelTag, 2)];
    assert.equal(validateProductionTrial(trials[0], modelTag, 1), trials[0]);
    return aggregateProductionModel({ digest: String(index + 1).repeat(64).slice(0, 64), dimension: 3, modelTag, resolvedTag: modelTag }, trials);
  });
  const result = buildProductionResult({ models, runMetadata: { generatedAt: "2030-01-01T00:00:00.000Z", node: "v24", ollamaVersion: "0.32.0", platform: "darwin/arm64" }, runtimeSources: await runtimeSourceProvenance() });
  assert.equal(validateProductionResult(result), result);

  const mismatched = completeTrial(ALLOWLISTED_MODELS[0], 2); mismatched.verdictHash = "0".repeat(64);
  assert.throws(() => aggregateProductionModel({ ...models[0], modelTag: ALLOWLISTED_MODELS[0] }, [completeTrial(ALLOWLISTED_MODELS[0], 1), mismatched]), /pass\^2/);
  const topKMutation = structuredClone(result); topKMutation.payload.productionConfig.topK = 4; topKMutation.payloadHash = sha256(`${canonicalJson(topKMutation.payload)}\n`);
  assert.throws(() => validateProductionResult(topKMutation), /config drift/);
  const forgedMetrics = structuredClone(result); forgedMetrics.payload.models[0].metrics[0].passed = 16; forgedMetrics.payload.models[0].metrics[0].rate = 0.8; forgedMetrics.payloadHash = sha256(`${canonicalJson(forgedMetrics.payload)}\n`);
  assert.throws(() => validateProductionResult(forgedMetrics), /failed-case reconciliation/);
  const privateMutation = structuredClone(result); privateMutation.payload.models[0].resolvedTag = "/Users/private/.muse/notes/secret.md"; privateMutation.payloadHash = sha256(`${canonicalJson(privateMutation.payload)}\n`);
  assert.throws(() => validateProductionResult(privateMutation), /private token/);
  const sourceMutation = structuredClone(result); sourceMutation.payload.runtimeSources[0].sha256 = "0".repeat(64); sourceMutation.payloadHash = sha256(`${canonicalJson(sourceMutation.payload)}\n`);

  const root = await mkdtemp(join(tmpdir(), "muse-production-recall-test-")); roots.push(root);
  const paths = { csv: join(root, "result.csv"), json: join(root, "result.json"), md: join(root, "result.md"), svg: join(root, "result.svg") };
  await writeFile(paths.json, `${canonicalJson(result)}\n`); await writeFile(paths.csv, renderCsv(result)); await writeFile(paths.md, renderMarkdown(result)); await writeFile(paths.svg, renderSvg(result));
  assert.equal((await validateArtifacts(paths)).payload.executionStatus, "COMPLETE");
  const svg = await readFile(paths.svg, "utf8"); assert.match(svg, /height="640" viewBox="0 0 1000 640"/u); assert.match(svg, /Legend/u); assert.match(svg, /<text x="35" y="584" class="sub">/u);
  assert.match(await readFile(paths.md, "utf8"), /not held-out or organic evidence/iu);
  await writeFile(paths.csv, `${renderCsv(result)}corrupt\n`);
  await assert.rejects(validateArtifacts(paths), /CSV/);
  await writeFile(paths.csv, renderCsv(sourceMutation)); await writeFile(paths.json, `${canonicalJson(sourceMutation)}\n`); await writeFile(paths.md, renderMarkdown(sourceMutation)); await writeFile(paths.svg, renderSvg(sourceMutation));
  await assert.rejects(validateArtifacts(paths), /source drift/);
});

test("terminal scorer separates ordinary confidence, absent abstention, and correction retention/current top-1", () => {
  const ordinary = { category: "ordinary-positive", expectedSource: "ordinary", currentSource: null, staleSource: null };
  const absent = { category: "absent", expectedSource: null, currentSource: null, staleSource: null };
  const correction = { category: "correction-pair", expectedSource: "current", currentSource: "current", staleSource: "stale" };

  assert.deepEqual(scoreProductionCase(ordinary, scored("ordinary"), (file) => file), { ok: true, reasonCode: null });
  assert.deepEqual(scoreProductionCase(ordinary, { ...scored("ordinary"), verdict: "ambiguous" }, (file) => file), { ok: false, reasonCode: "NOT_CONFIDENT" });
  assert.deepEqual(scoreProductionCase(absent, { scored: [], verdict: "none" }, (file) => file), { ok: true, reasonCode: null });
  assert.deepEqual(scoreProductionCase(absent, scored("ordinary"), (file) => file), { ok: false, reasonCode: "ABSENT_CONFIDENT" });
  assert.deepEqual(scoreProductionCase(correction, scored("current", "stale"), (file) => file), { ok: true, reasonCode: null });
  assert.deepEqual(scoreProductionCase(correction, scored("stale", "current"), (file) => file), { ok: false, reasonCode: "STALE_TOP1" });
  assert.deepEqual(scoreProductionCase(correction, scored("current"), (file) => file), { ok: false, reasonCode: "PAIR_MISSING" });
});
