#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalJson, sha256 } from "./eval-recall-freshness-ablation.mjs";

export const DASHBOARD_SCHEMA_VERSION = "muse-evidence-dashboard.v1";
export const HISTORICAL_REVISION = "5aa4a85ef";
export const METRIC_FIELDS = Object.freeze([
  "metricId", "chartId", "kind", "label", "unit", "value", "denominator",
  "evidenceClass", "status", "sourcePath", "sourceRevision", "sourceSha256",
  "selector", "command", "verifiedAt"
]);
export const CHART_METRICS = Object.freeze({
  "effect-deltas": Object.freeze([
    "grounding.self-authored.faithfulness-delta",
    "grounding.squad.faithfulness-delta",
    "recall.correction-pass-delta"
  ]),
  "evidence-coverage": Object.freeze([
    "agent.capability-axes",
    "recall.raw-top4-pair-retained",
    "continuity.provenance-exact-pairs",
    "organic.personal-effectiveness"
  ]),
  "project-surface": Object.freeze([
    "surface.http-endpoints",
    "surface.packages-and-apps",
    "surface.mcp-servers",
    "surface.provider-families",
    "surface.test-cases",
    "surface.live-roundtrip"
  ])
});
export const REQUIRED_METRIC_IDS = Object.freeze(Object.values(CHART_METRICS).flat());

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPaths = Object.freeze({
  json: join(repoRoot, "docs", "benchmarks", "evidence-dashboard.json"),
  deltas: join(repoRoot, "docs", "benchmarks", "evidence-effect-deltas.svg"),
  coverage: join(repoRoot, "docs", "benchmarks", "evidence-coverage.svg"),
  surface: join(repoRoot, "docs", "benchmarks", "evidence-project-surface.svg")
});
const execFileAsync = promisify(execFile);
const CLOSED_DELTA_UNITS = Object.freeze(["faithfulness delta", "correction-pass delta"]);
const CLOSED_STATUSES = Object.freeze([
  "qualified component result", "UNCHANGED", "aggregate FAILED", "diagnostic",
  "technical-only", "NOT_PROVEN classification", "passing snapshot", "inventory", "NOT_RUN"
]);
const MCP_EXCLUDED_FILES = new Set(["loopback-context.ts"]);
const PROVIDER_FAMILIES = Object.freeze([
  "anthropic", "codex-cli", "gemini", "ollama", "openai", "openai-compatible", "openrouter"
]);

function jsonBytes(value) { return `${canonicalJson(value)}\n`; }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) throw new Error(`${label} fields mismatch`);
}
function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function metric(input) { return Object.freeze(input); }
async function fileBytes(path) { return readFile(join(repoRoot, path), "utf8"); }
function exactRegex(text, regex, label) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) throw new Error(`${label} selector mismatch`);
  return matches[0];
}
async function gitText(args) {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return stdout;
}
async function revisionMetadata() {
  const revision = (await gitText(["rev-parse", HISTORICAL_REVISION])).trim();
  const verifiedAt = (await gitText(["show", "-s", "--format=%cI", HISTORICAL_REVISION])).trim();
  return { revision, verifiedAt };
}
async function directoryInventory() {
  const names = [];
  for (const root of ["apps", "packages"]) {
    for (const entry of await readdir(join(repoRoot, root), { withFileTypes: true })) if (entry.isDirectory()) names.push(`${root}/${entry.name}`);
  }
  names.sort();
  if (names.length !== 41) throw new Error(`workspace inventory count drift: ${names.length}`);
  return names;
}
async function mcpInventory() {
  const root = join(repoRoot, "packages", "domain-tools", "src");
  const files = (await readdir(root)).filter((name) => /^loopback-.*\.ts$/u.test(name) && !name.endsWith(".test.ts") && !MCP_EXCLUDED_FILES.has(name)).sort();
  const names = [];
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    for (const match of source.matchAll(/\bname:\s*"(muse\.[^"]+)"/gu)) names.push(match[1]);
  }
  const unique = [...new Set(names)].sort();
  if (unique.length !== 25) throw new Error(`MCP inventory count drift: ${unique.length}`);
  return unique;
}
async function providerInventory() {
  const index = await fileBytes("packages/model/src/index.ts");
  for (const token of ["AnthropicProvider", "CodexCliProvider", "GeminiProvider", "OllamaProvider", "OpenAIProvider", "OpenAICompatibleProvider", "OpenRouterProvider"]) {
    if (!index.includes(token)) throw new Error(`provider inventory drift: ${token}`);
  }
  return [...PROVIDER_FAMILIES];
}
function source(metricBase, source) { return metric({ ...metricBase, ...source }); }

export async function buildDashboardResult() {
  const { revision, verifiedAt } = await revisionMetadata();
  const [grounding, squad, freshnessBytes, capability, provenance, packageJsonBytes, workspaceNames, mcpNames, providerNames] = await Promise.all([
    fileBytes("docs/benchmarks/RESULTS.md"), fileBytes("docs/benchmarks/RESULTS-squad.md"),
    fileBytes("docs/benchmarks/recall-freshness-ablation.json"), fileBytes("docs/development/agent-capability-baseline.md"),
    fileBytes("docs/evaluations/continuity-evidence-provenance-2026-07-18.md"), fileBytes("package.json"),
    directoryInventory(), mcpInventory(), providerInventory()
  ]);
  const historicalReadme = await gitText(["show", `${HISTORICAL_REVISION}:README.md`]);
  const freshness = JSON.parse(freshnessBytes);
  if (freshness.payloadHash !== "b61768aea906cef00b74a9e519087320a21704db7a506762103b9883c5fe6f4b" || freshness.payload.status !== "UNCHANGED") throw new Error("accepted freshness payload drift");
  const correctionDeltas = freshness.payload.models.map((item) => item.correctionDelta);
  if (canonicalJson(correctionDeltas) !== canonicalJson([0, 0, 0, 0])) throw new Error("freshness delta drift");
  const pairMissing = freshness.payload.models.reduce((count, model) => count + model.failedCases.filter((item) => item.arm === "raw-retrieval" && item.category === "correction-pair" && item.reasonCode === "PAIR_MISSING").length, 0);
  if (80 - pairMissing !== 8) throw new Error("accepted top-4 retention drift");
  exactRegex(grounding, /\| \*\*Δ \(ON − OFF\)\*\* \| \*\*\+0\.94\*\* \| \+0\.00 \|/gu, "grounding delta");
  exactRegex(squad, /\| \*\*Δ \(ON − OFF\)\*\* \| \*\*\+0\.63\*\* \| \+0\.00 \|/gu, "SQuAD delta");
  exactRegex(capability, /Summary: \*\*10 passed, 1 failed, 0 unverified, 11 total\*\*/gu, "agent capability");
  exactRegex(provenance, /\| Technical controlled deliveries \/ receipts \/ exact states \| 10,080 \/ 10,080 \/ 10,080 \|/gu, "provenance exact pairs");
  exactRegex(provenance, /\| Resulting organic \/ controlled \/ unclassified classes \| 0 \/ 0 \/ 1,000 \|/gu, "organic classification");
  exactRegex(historicalReadme, /\*\*51 endpoints\*\* exercised with a key-free diagnostic provider/gu, "historical endpoints");
  exactRegex(historicalReadme, /\*\*18,484 passing cases\*\* across 1,624 test files/gu, "historical tests");
  const packageJson = JSON.parse(packageJsonBytes);
  if (packageJson.scripts?.["smoke:live"] !== "node scripts/smoke-live-llm.mjs") throw new Error("live round-trip command drift");

  const fileSource = (path, bytes, selector, command) => ({ command, selector, sourcePath: path, sourceRevision: revision, sourceSha256: sha256(bytes), verifiedAt });
  const jsonSource = (selector, command) => ({ command, selector, sourcePath: "docs/benchmarks/recall-freshness-ablation.json", sourceRevision: freshness.payloadHash, sourceSha256: sha256(freshnessBytes), verifiedAt: freshness.runMetadata.generatedAt });
  const inventorySource = (path, names, selector, command) => ({ command, selector, sourcePath: path, sourceRevision: revision, sourceSha256: sha256(jsonBytes(names)), verifiedAt });
  const historySource = (selector, command) => ({ command, selector, sourcePath: "README.md", sourceRevision: revision, sourceSha256: sha256(historicalReadme), verifiedAt });

  const metrics = [
    source({ metricId: CHART_METRICS["effect-deltas"][0], chartId: "effect-deltas", kind: "delta", label: "Self-authored grounding", unit: "faithfulness delta", value: 0.94, denominator: null, evidenceClass: "controlled local-model component", status: "qualified component result" }, fileSource("docs/benchmarks/RESULTS.md", grounding, "exact regex: Δ (ON − OFF) = +0.94; false-refusal +0.00", "pnpm eval:grounding-delta")),
    source({ metricId: CHART_METRICS["effect-deltas"][1], chartId: "effect-deltas", kind: "delta", label: "SQuAD-2.0 grounding", unit: "faithfulness delta", value: 0.63, denominator: null, evidenceClass: "controlled local-model component", status: "qualified component result" }, fileSource("docs/benchmarks/RESULTS-squad.md", squad, "exact regex: Δ (ON − OFF) = +0.63; false-refusal +0.00", "pnpm eval:grounding-delta:squad")),
    source({ metricId: CHART_METRICS["effect-deltas"][2], chartId: "effect-deltas", kind: "delta", label: "Recall correction pass", unit: "correction-pass delta", value: 0, denominator: null, evidenceClass: "local-live retrieval component", status: "UNCHANGED" }, jsonSource("/payload/models/*/correctionDelta exactly [0,0,0,0]; pass requires pair retained + current top-1", "pnpm eval:recall-freshness-ablation")),
    source({ metricId: CHART_METRICS["evidence-coverage"][0], chartId: "evidence-coverage", kind: "ratio", label: "Agent capability axes", unit: "axes", value: 10, denominator: 11, evidenceClass: "local-live agent capability", status: "aggregate FAILED" }, fileSource("docs/development/agent-capability-baseline.md", capability, "exact regex: Summary 10 passed, 1 failed, 0 unverified, 11 total", "pnpm eval:agent -- --json")),
    source({ metricId: CHART_METRICS["evidence-coverage"][1], chartId: "evidence-coverage", kind: "ratio", label: "Raw top-4 pair retained", unit: "model-cases", value: 8, denominator: 80, evidenceClass: "local-live retrieval component", status: "diagnostic" }, jsonSource("/payload/models/*/failedCases raw correction PAIR_MISSING => 8/80 retained", "pnpm eval:recall-freshness-ablation")),
    source({ metricId: CHART_METRICS["evidence-coverage"][2], chartId: "evidence-coverage", kind: "ratio", label: "Provenance isolation", unit: "exact pairs", value: 10080, denominator: 10080, evidenceClass: "controlled / synthetic", status: "technical-only" }, fileSource("docs/evaluations/continuity-evidence-provenance-2026-07-18.md", provenance, "exact regex: technical controlled deliveries / receipts / exact states = 10,080 / 10,080 / 10,080", "pnpm eval:continuity-provenance")),
    source({ metricId: CHART_METRICS["evidence-coverage"][3], chartId: "evidence-coverage", kind: "ratio", label: "Organic classifications", unit: "classifications", value: 0, denominator: 1000, evidenceClass: "organic personal effectiveness", status: "NOT_PROVEN classification" }, fileSource("docs/evaluations/continuity-evidence-provenance-2026-07-18.md", provenance, "exact regex: organic / controlled / unclassified = 0 / 0 / 1,000", "pnpm eval:continuity-provenance")),
    source({ metricId: CHART_METRICS["project-surface"][0], chartId: "project-surface", kind: "count", label: "HTTP endpoints", unit: "endpoints", value: 51, denominator: null, evidenceClass: "software assurance", status: "passing snapshot" }, historySource("git 5aa4a85ef README exact regex: 51 endpoints", "pnpm smoke:broad")),
    source({ metricId: CHART_METRICS["project-surface"][1], chartId: "project-surface", kind: "count", label: "Packages + apps", unit: "directories", value: workspaceNames.length, denominator: null, evidenceClass: "inventory", status: "inventory" }, inventorySource("apps/ + packages/", workspaceNames, "sorted immediate directory names", "find apps packages -mindepth 1 -maxdepth 1 -type d")),
    source({ metricId: CHART_METRICS["project-surface"][2], chartId: "project-surface", kind: "count", label: "Built-in MCP servers", unit: "servers", value: mcpNames.length, denominator: null, evidenceClass: "inventory", status: "inventory" }, inventorySource("packages/domain-tools/src/loopback-*.ts", mcpNames, "sorted unique muse.* names excluding runtime-only loopback-context.ts", "muse mcp list")),
    source({ metricId: CHART_METRICS["project-surface"][3], chartId: "project-surface", kind: "count", label: "Provider families", unit: "families", value: providerNames.length, denominator: null, evidenceClass: "inventory", status: "inventory" }, inventorySource("packages/model/src/index.ts", providerNames, "sorted public ModelProvider family names", "pnpm --filter @muse/model build")),
    source({ metricId: CHART_METRICS["project-surface"][4], chartId: "project-surface", kind: "count", label: "Passing test cases", unit: "test cases", value: 18484, denominator: null, evidenceClass: "software assurance", status: "passing snapshot" }, historySource("git 5aa4a85ef README exact regex: 18,484 passing cases across 1,624 files", "pnpm check")),
    source({ metricId: CHART_METRICS["project-surface"][5], chartId: "project-surface", kind: "status", label: "Real-LLM round-trip", unit: "command availability", value: null, denominator: null, evidenceClass: "local-live agent capability", status: "NOT_RUN" }, fileSource("package.json", packageJsonBytes, "/scripts/smoke:live = node scripts/smoke-live-llm.mjs", "pnpm smoke:live"))
  ];
  const payload = { metrics, statement: "Evidence classes and units are not comparable / not aggregatable." };
  const result = { payload, payloadHash: sha256(jsonBytes(payload)), schemaVersion: DASHBOARD_SCHEMA_VERSION };
  return validateDashboardResult(result);
}

export function validateDashboardResult(result) {
  exactKeys(result, ["payload", "payloadHash", "schemaVersion"], "dashboard result");
  exactKeys(result.payload, ["metrics", "statement"], "dashboard payload");
  if (result.schemaVersion !== DASHBOARD_SCHEMA_VERSION || result.payloadHash !== sha256(jsonBytes(result.payload))) throw new Error("dashboard hash/version mismatch");
  if (result.payload.statement !== "Evidence classes and units are not comparable / not aggregatable.") throw new Error("dashboard boundary mismatch");
  if (!Array.isArray(result.payload.metrics) || result.payload.metrics.length !== REQUIRED_METRIC_IDS.length) throw new Error("metric cardinality mismatch");
  const ids = result.payload.metrics.map((item) => item.metricId);
  if (new Set(ids).size !== ids.length || canonicalJson(ids) !== canonicalJson(REQUIRED_METRIC_IDS)) throw new Error("metric id/order mismatch");
  for (const [index, item] of result.payload.metrics.entries()) {
    exactKeys(item, METRIC_FIELDS, `metric ${index}`);
    if (item.metricId !== REQUIRED_METRIC_IDS[index] || !Object.hasOwn(CHART_METRICS, item.chartId) || !CHART_METRICS[item.chartId].includes(item.metricId)) throw new Error("metric chart assignment mismatch");
    if (!CLOSED_STATUSES.includes(item.status) || typeof item.label !== "string" || !item.label || typeof item.unit !== "string" || !item.unit || typeof item.evidenceClass !== "string" || !item.evidenceClass) throw new Error("metric closed value mismatch");
    if (!["delta", "ratio", "count", "status"].includes(item.kind)) throw new Error("unknown metric kind");
    if (item.kind === "delta" && (!Number.isFinite(item.value) || item.denominator !== null || !CLOSED_DELTA_UNITS.includes(item.unit))) throw new Error("delta shape mismatch");
    if (item.kind === "ratio" && (!Number.isFinite(item.value) || item.value < 0 || !Number.isFinite(item.denominator) || item.denominator <= 0 || item.value > item.denominator)) throw new Error("ratio shape mismatch");
    if (item.kind === "count" && (!Number.isInteger(item.value) || item.value < 0 || item.denominator !== null)) throw new Error("count shape mismatch");
    if (item.kind === "status" && (item.value !== null || item.denominator !== null || item.status !== "NOT_RUN")) throw new Error("status shape mismatch");
    if (typeof item.sourcePath !== "string" || typeof item.sourceRevision !== "string" || !/^[a-f0-9]{40,64}$/u.test(item.sourceRevision) || !/^[a-f0-9]{64}$/u.test(item.sourceSha256) || typeof item.selector !== "string" || typeof item.command !== "string" || Number.isNaN(Date.parse(item.verifiedAt))) throw new Error("source provenance mismatch");
  }
  return result;
}

function svgShell(title, desc, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc"><title id="title">${escapeXml(title)}</title><desc id="desc">${escapeXml(desc)}</desc><style>text{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;fill:#172033}.title{font-size:28px;font-weight:760}.sub{font-size:14px;fill:#536075}.label{font-size:17px;font-weight:700}.value{font-size:25px;font-weight:780}.meta{font-size:12px;fill:#536075}.status{font-size:12px;font-weight:700}.footer{font-size:12px;font-weight:700;fill:#536075}.card,.row{fill:#f8fafc;stroke:#dce3ec}.track{fill:#e7edf5}.bar{fill:#2563eb}.cyan{fill:#0891b2}.purple{fill:#7c3aed}.amber{fill:#d97706}</style><rect width="1200" height="${height}" fill="#fff"/>${body}</svg>\n`;
}
export function renderEffectDeltas(result) {
  const items = result.payload.metrics.filter((item) => item.chartId === "effect-deltas");
  const rows = items.map((item, index) => {
    const y = 112 + index * 125; const barWidth = item.value === 0 ? 3 : 270; const barClass = index === 1 ? "cyan" : index === 2 ? "purple" : "bar";
    return `<rect class="row" x="40" y="${y}" width="1120" height="105" rx="16"/><text class="label" x="64" y="${y + 34}">${escapeXml(item.label)}</text><text class="value" x="64" y="${y + 76}">${item.value >= 0 ? "+" : ""}${item.value.toFixed(2)}</text><text class="meta" x="150" y="${y + 76}">${escapeXml(item.unit)}</text><text class="meta" x="380" y="${y + 34}">evidence · ${escapeXml(item.evidenceClass)}</text><text class="status" x="380" y="${y + 80}">status · ${escapeXml(item.status)}</text><rect class="track" x="820" y="${y + 48}" width="300" height="12" rx="6"/><rect class="${barClass}" x="820" y="${y + 48}" width="${barWidth}" height="12" rx="6"/><text class="meta" x="820" y="${y + 82}">${item.value === 0 ? "no measured change" : "positive measured change"} · independent scale</text>`;
  }).join("");
  return svgShell("Component effect deltas", "Three full-width rows show signed component deltas. Positive means better; each row has its own outcome scale and cannot be compared or aggregated.", 580, `<text class="title" x="40" y="48">Component effect deltas</text><text class="sub" x="40" y="77">Legend · positive = better · each row uses its own outcome scale</text>${rows}<text class="footer" x="40" y="520">Independent scales · not comparable / not aggregatable · no average or ranking</text>`);
}
export function renderEvidenceCoverage(result) {
  const items = result.payload.metrics.filter((item) => item.chartId === "evidence-coverage");
  const rows = items.map((item, index) => { const y = 132 + index * 108; const ratio = item.value / item.denominator; return `<text class="label" x="40" y="${y}">${escapeXml(item.label)}</text><text class="value" x="1120" y="${y}" text-anchor="end">${item.value.toLocaleString("en-US")}/${item.denominator.toLocaleString("en-US")}</text><rect class="track" x="40" y="${y + 18}" width="1080" height="20" rx="10"/><rect class="bar" x="40" y="${y + 18}" width="${1080 * ratio}" height="20" rx="10"/><text class="meta" x="40" y="${y + 58}">${escapeXml(item.evidenceClass)}</text><text class="status" x="1120" y="${y + 58}" text-anchor="end">${escapeXml(item.status)}</text>`; }).join("");
  return svgShell("Evidence coverage and boundaries", "Four ratio bars show numerator over each metric's own denominator. Rows have different evidence classes and are not comparable or aggregatable.", 680, `<text class="title" x="40" y="48">Evidence coverage and boundaries</text><text class="sub" x="40" y="77">Legend · bar = numerator ÷ its own denominator · row lengths have no shared meaning</text>${rows}<text class="footer" x="40" y="620">Within-metric ratios only · not comparable / not aggregatable · synthetic scale is not organic effectiveness</text>`);
}
export function renderProjectSurface(result) {
  const items = result.payload.metrics.filter((item) => item.chartId === "project-surface");
  const cards = items.map((item, index) => { const column = index % 3; const row = Math.floor(index / 3); const x = 40 + column * 380; const y = 128 + row * 190; const display = item.kind === "status" ? item.status : item.value.toLocaleString("en-US"); return `<rect class="card" x="${x}" y="${y}" width="350" height="160" rx="16"/><text class="label" x="${x + 22}" y="${y + 38}">${escapeXml(item.label)}</text><text class="value" x="${x + 22}" y="${y + 82}">${escapeXml(display)}</text><text class="meta" x="${x + 22}" y="${y + 108}">${escapeXml(item.unit)} · ${escapeXml(item.evidenceClass)}</text><text class="status" x="${x + 22}" y="${y + 136}">status: ${escapeXml(item.status)}</text>`; }).join("");
  return svgShell("Project surface snapshots", "Inventory, software assurance, and live-command status cards use different units and no shared quantitative axis.", 600, `<text class="title" x="40" y="48">Project surface snapshots</text><text class="sub" x="40" y="77">Legend · cards use their own units · NOT_RUN is command status, not a performance pass</text>${cards}<text class="footer" x="40" y="548">Different units · not comparable / not aggregatable · inventory and test volume are not effect evidence</text>`);
}

export async function validateDashboardArtifacts(paths = outputPaths) {
  const bytes = await readFile(paths.json, "utf8");
  if (!bytes.endsWith("\n")) throw new Error("dashboard JSON must end with LF");
  const result = validateDashboardResult(JSON.parse(bytes));
  if (bytes !== jsonBytes(result)) throw new Error("dashboard JSON canonical bytes mismatch");
  const current = await buildDashboardResult();
  if (canonicalJson(current) !== canonicalJson(result)) throw new Error("dashboard source drift");
  const expected = { deltas: renderEffectDeltas(result), coverage: renderEvidenceCoverage(result), surface: renderProjectSurface(result) };
  for (const [key, value] of Object.entries(expected)) if (await readFile(paths[key], "utf8") !== value) throw new Error(`${key} SVG drift`);
  return result;
}
async function writeAtomic(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.tmp-${process.pid}`; await writeFile(temporary, value, { mode: 0o644 }); await rename(temporary, path); }
export async function renderDashboard(paths = outputPaths) {
  const result = await buildDashboardResult();
  await writeAtomic(paths.json, jsonBytes(result));
  await writeAtomic(paths.deltas, renderEffectDeltas(result));
  await writeAtomic(paths.coverage, renderEvidenceCoverage(result));
  await writeAtomic(paths.surface, renderProjectSurface(result));
  return validateDashboardArtifacts(paths);
}

async function main() {
  if (process.argv.slice(2).filter((item) => item !== "--").includes("--validate")) await validateDashboardArtifacts();
  else await renderDashboard();
  process.stdout.write(`${canonicalJson({ payloadHash: (await validateDashboardArtifacts()).payloadHash, status: "VALID" })}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
