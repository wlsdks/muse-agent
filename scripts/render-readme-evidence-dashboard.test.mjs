import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./eval-recall-freshness-ablation.mjs";
import {
  CHART_METRICS,
  METRIC_FIELDS,
  REQUIRED_METRIC_IDS,
  buildDashboardResult,
  renderDashboard,
  renderEffectDeltas,
  renderEvidenceCoverage,
  renderProjectSurface,
  validateDashboardArtifacts,
  validateDashboardResult
} from "./render-readme-evidence-dashboard.mjs";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
function rehash(result) { result.payloadHash = sha256(`${canonicalJson(result.payload)}\n`); return result; }
async function tempPaths() {
  const root = await mkdtemp(join(tmpdir(), "muse-evidence-dashboard-test-")); roots.push(root);
  return { json: join(root, "dashboard.json"), deltas: join(root, "deltas.svg"), coverage: join(root, "coverage.svg"), surface: join(root, "surface.svg") };
}

test("dashboard manifest has the exact global ids, order, chart assignment, and closed metric fields", async () => {
  const result = await buildDashboardResult();
  assert.equal(validateDashboardResult(result), result);
  assert.deepEqual(result.payload.metrics.map((item) => item.metricId), REQUIRED_METRIC_IDS);
  assert.equal(new Set(result.payload.metrics.map((item) => item.metricId)).size, REQUIRED_METRIC_IDS.length);
  for (const metric of result.payload.metrics) {
    assert.deepEqual(Object.keys(metric).sort(), [...METRIC_FIELDS].sort());
    assert.ok(CHART_METRICS[metric.chartId].includes(metric.metricId));
  }
  const freshness = result.payload.metrics.find((item) => item.metricId === "recall.correction-pass-delta");
  assert.equal(freshness.unit, "correction-pass delta"); assert.equal(freshness.value, 0); assert.match(freshness.selector, /pair retained \+ current top-1/);
  const svg = renderEffectDeltas(result); assert.match(svg, /correction-pass delta/); assert.doesNotMatch(svg, /current-top1 delta/);
});

test("unknown, duplicate, extra, and invalid kind shapes fail closed", async () => {
  const baseline = await buildDashboardResult();
  const duplicate = structuredClone(baseline); duplicate.payload.metrics[1].metricId = duplicate.payload.metrics[0].metricId;
  assert.throws(() => validateDashboardResult(rehash(duplicate)), /metric id\/order/);
  const extra = structuredClone(baseline); extra.payload.metrics[0].surprise = true;
  assert.throws(() => validateDashboardResult(rehash(extra)), /fields mismatch/);
  const badDelta = structuredClone(baseline); badDelta.payload.metrics[0].denominator = 1;
  assert.throws(() => validateDashboardResult(rehash(badDelta)), /delta shape/);
  const badStatus = structuredClone(baseline); badStatus.payload.metrics.at(-1).value = 1;
  assert.throws(() => validateDashboardResult(rehash(badStatus)), /status shape/);
  const unknown = structuredClone(baseline); unknown.payload.metrics[0].status = "PASS";
  assert.throws(() => validateDashboardResult(rehash(unknown)), /closed value/);
});

test("canonical JSON is the only truth and all SVGs reconcile byte-for-byte", async () => {
  const paths = await tempPaths(); const result = await renderDashboard(paths);
  assert.equal((await validateDashboardArtifacts(paths)).payloadHash, result.payloadHash);
  for (const [key, renderer] of [["deltas", renderEffectDeltas], ["coverage", renderEvidenceCoverage], ["surface", renderProjectSurface]]) {
    const svg = await readFile(paths[key], "utf8");
    assert.equal(svg, renderer(result)); assert.match(svg, /<title id="title">/); assert.match(svg, /<desc id="desc">/);
    assert.match(svg, /not comparable \/ not aggregatable/);
  }
  await writeFile(paths.coverage, `${await readFile(paths.coverage, "utf8")}corrupt`);
  await assert.rejects(validateDashboardArtifacts(paths), /coverage SVG drift/);
});

test("README-retained dashboard SVGs keep row text and footers inside measured padding", async () => {
  const result = await buildDashboardResult();
  const deltas = renderEffectDeltas(result);
  assert.doesNotMatch(deltas, /width="350" height="355"/u, "effect deltas must not return to three narrow cards");
  const deltaRows = [...deltas.matchAll(/<rect class="row" x="40" y="(\d+)" width="1120" height="105"/gu)];
  const deltaBaselines = [...deltas.matchAll(/<text class="status" x="380" y="(\d+)"/gu)];
  assert.equal(deltaRows.length, 3); assert.equal(deltaBaselines.length, 3);
  for (let index = 0; index < deltaRows.length; index += 1) assert.ok(Number(deltaRows[index][1]) + 105 - Number(deltaBaselines[index][1]) >= 24);
  assert.match(deltas, /height="580" viewBox="0 0 1200 580"/u); assert.match(deltas, /<text class="footer" x="40" y="520"/u);

  const coverage = renderEvidenceCoverage(result); const surface = renderProjectSurface(result);
  assert.match(coverage, /height="680" viewBox="0 0 1200 680"/u); assert.match(coverage, /<text class="footer" x="40" y="620"/u);
  assert.match(surface, /height="600" viewBox="0 0 1200 600"/u); assert.match(surface, /<text class="footer" x="40" y="548"/u);
  for (const svg of [deltas, coverage, surface]) {
    assert.match(svg, /<title id="title">/u); assert.match(svg, /<desc id="desc">/u); assert.match(svg, /legend|Legend/iu);
  }
});

test("source hash mutation cannot be accepted as a rendered snapshot", async () => {
  const paths = await tempPaths(); const result = await renderDashboard(paths);
  const mutated = structuredClone(result); mutated.payload.metrics[0].sourceSha256 = "0".repeat(64); rehash(mutated);
  await writeFile(paths.json, `${canonicalJson(mutated)}\n`);
  await assert.rejects(validateDashboardArtifacts(paths), /dashboard source drift/);
});

// The README-curation test lived here. README.md was rebuilt on 2026-07-30 and no longer
// carries a "Muse in numbers" section curating these charts — the evidence index
// (docs/benchmarks/EVIDENCE.md) owns that presentation now, and eval-recall-freshness-ablation
// .test.mjs pins the boundary counts there. The manifest tests below still guard the data.


test("evidence index links every README chart", async () => {
  const evidence = await readFile(new URL("../docs/benchmarks/EVIDENCE.md", import.meta.url), "utf8");
  for (const file of ["evidence-effect-deltas.svg", "evidence-coverage.svg", "recall-production-path.svg", "recall-freshness-ablation.svg", "recall-candidate-pool.svg", "evidence-project-surface.svg"]) assert.match(evidence, new RegExp(`\\(${file.replaceAll(".", "\\.")}\\)`, "u"));
});
