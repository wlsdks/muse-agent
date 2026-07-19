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

test("source hash mutation cannot be accepted as a rendered snapshot", async () => {
  const paths = await tempPaths(); const result = await renderDashboard(paths);
  const mutated = structuredClone(result); mutated.payload.metrics[0].sourceSha256 = "0".repeat(64); rehash(mutated);
  await writeFile(paths.json, `${canonicalJson(mutated)}\n`);
  await assert.rejects(validateDashboardArtifacts(paths), /dashboard source drift/);
});

test("README Muse in numbers is chart-only with alt text and adjacent source/reproduce links", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const start = readme.indexOf("## 📊 Muse in numbers"); const end = readme.indexOf("\n## ", start + 4); const section = readme.slice(start, end);
  assert.ok(start >= 0 && end > start); assert.doesNotMatch(section, /^\|.*\|$/gmu); assert.doesNotMatch(section, /last column/iu);
  for (const file of ["evidence-effect-deltas.svg", "evidence-coverage.svg", "evidence-project-surface.svg", "recall-freshness-ablation.svg", "recall-candidate-pool.svg"]) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(section, new RegExp(`!\\[[^\\]]+\\]\\(docs/benchmarks/${escaped}\\)\\n\\nSource: [^\\n]+reproduce`, "u"));
  }
  assert.match(section, /canonical evidence dashboard/iu); assert.match(section, /not compared or aggregated/iu);
  assert.match(section, /correction pass at top K four, eight, and twelve/iu);
});
