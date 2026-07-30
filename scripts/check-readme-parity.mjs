#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateReadmeEvidenceResult } from "./render-readme-qualified-evidence.mjs";

const ROOT_FIELDS = ["evidence", "locales", "metricSections", "requiredCommands", "requiredLinks", "schemaVersion", "sections"];
const LOCALE_FIELDS = ["boundaryTokens", "file", "forbiddenPatterns", "id", "languageSwitch", "title"];
const SECTION_FIELDS = ["headings", "id"];
const METRIC_SECTION_FIELDS = ["chartFile", "evidenceLink", "headings", "id", "requiredTokens"];
const EVIDENCE_FIELDS = ["evidenceIndexPath", "expectedCharts", "forbiddenReadmeCharts", "publicationManifestPath", "requiredReadmeStatuses"];
const EXPECTED_CHART_FIELDS = ["file", "status"];
const EXPECTED_LOCALES = ["en"];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error(`${label} fields mismatch: ${actual.join(",")}`);
}

function normalizeHeading(value) {
  return value.normalize("NFKC").replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/gu, "").replace(/\s+/gu, " ").trim();
}

function markdownHeadings(text) {
  return text.split(/\r?\n/u).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    return match ? [{ heading: normalizeHeading(match[2]), index, level: match[1].length }] : [];
  });
}

export function documentTitles(text) {
  const markdownTitles = markdownHeadings(text)
    .filter(({ level }) => level === 1)
    .map(({ heading }) => heading);
  const htmlTitles = [...text.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/giu)]
    .map((match) => normalizeHeading(match[1].replace(/<[^>]+>/gu, "")));
  return [...new Set([...markdownTitles, ...htmlTitles])];
}

function sectionText(text, allowedHeadings) {
  const lines = text.split(/\r?\n/u);
  const headings = markdownHeadings(text);
  const start = headings.find((item) => allowedHeadings.includes(item.heading));
  if (!start) return null;
  const end = headings.find((item) => item.index > start.index && item.level <= start.level)?.index ?? lines.length;
  return lines.slice(start.index, end).join("\n");
}

function localTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) targets.push(match[1].trim().split(/\s+["']/u)[0]);
  for (const match of markdown.matchAll(/(?:href|src)="([^"]+)"/gu)) targets.push(match[1].trim());
  return [...new Set(targets)].filter((target) => target && !target.startsWith("#") && !/^(?:https?:|mailto:|data:)/iu.test(target));
}

async function assertLocalLinks({ filePath, markdown, root }) {
  for (const rawTarget of localTargets(markdown)) {
    const target = decodeURIComponent(rawTarget.split("#")[0].split("?")[0]);
    if (!target) continue;
    if (isAbsolute(target)) throw new Error(`${relative(root, filePath)} has absolute local link: ${rawTarget}`);
    const resolved = resolve(dirname(filePath), target);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${relative(root, filePath)} link escapes repository: ${rawTarget}`);
    try { await stat(resolved); } catch { throw new Error(`${relative(root, filePath)} has missing local link: ${rawTarget}`); }
  }
}

export function validateManifestShape(manifest) {
  exactKeys(manifest, ROOT_FIELDS, "manifest");
  if (manifest.schemaVersion !== "muse-readme-parity.v2") throw new Error("manifest schemaVersion mismatch");
  if (!Array.isArray(manifest.locales) || !Array.isArray(manifest.sections) || !Array.isArray(manifest.metricSections)) throw new Error("manifest arrays missing");
  for (const locale of manifest.locales) exactKeys(locale, LOCALE_FIELDS, `locale ${locale?.id ?? "unknown"}`);
  for (const section of manifest.sections) exactKeys(section, SECTION_FIELDS, `section ${section?.id ?? "unknown"}`);
  for (const section of manifest.metricSections) exactKeys(section, METRIC_SECTION_FIELDS, `metric section ${section?.id ?? "unknown"}`);
  exactKeys(manifest.evidence, EVIDENCE_FIELDS, "evidence");
  for (const chart of manifest.evidence.expectedCharts) exactKeys(chart, EXPECTED_CHART_FIELDS, `expected chart ${chart?.file ?? "unknown"}`);
  if (manifest.metricSections.length !== 2 || manifest.evidence.expectedCharts.length !== 2) throw new Error("README publication must contain exactly two charts");
  const localeIds = manifest.locales.map((item) => item.id).sort();
  if (JSON.stringify(localeIds) !== JSON.stringify(EXPECTED_LOCALES)) throw new Error("manifest locale set mismatch");
  for (const section of [...manifest.sections, ...manifest.metricSections]) {
    if (JSON.stringify(Object.keys(section.headings).sort()) !== JSON.stringify(EXPECTED_LOCALES)) throw new Error(`${section.id} locale heading set mismatch`);
  }
}

async function validateCanonicalEvidence({ manifest, root }) {
  const publication = validateReadmeEvidenceResult(JSON.parse(await readFile(join(root, manifest.evidence.publicationManifestPath), "utf8")));
  const actualCharts = publication.payload.charts.map(({ file, status }) => ({ file, status }));
  if (JSON.stringify(actualCharts) !== JSON.stringify(manifest.evidence.expectedCharts)) throw new Error("README publication chart/status set mismatch");
  const evidenceIndex = await readFile(join(root, manifest.evidence.evidenceIndexPath), "utf8");
  for (const token of ["10/11", "FAILED", "NOT_PROVEN", ...manifest.evidence.expectedCharts.map(({ file }) => file), ...manifest.evidence.forbiddenReadmeCharts]) {
    if (!evidenceIndex.toUpperCase().includes(token.toUpperCase())) throw new Error(`evidence index publication/history missing: ${token}`);
  }
  for (const { file } of manifest.evidence.expectedCharts) {
    const svg = await readFile(join(root, "docs", "benchmarks", file), "utf8");
    if (!/^<svg[^>]+width="1200"[^>]+viewBox="0 0 1200 [67]00"[^>]+role="img"[^>]+aria-labelledby="title desc"/u.test(svg)) throw new Error(`README chart layout/accessibility shell mismatch: ${file}`);
    if (!/<title id="title">[^<]+<\/title><desc id="desc">[^<]+<\/desc>/u.test(svg)) throw new Error(`README chart accessible text missing: ${file}`);
    if (/x="(?:0|1200)" y=|y="(?:0|600|700)"[^>]*>[^<]*\S/u.test(svg)) throw new Error(`README chart content exceeds measured padding: ${file}`);
  }
}

export async function validateReadmeParity({ manifestPath = join(process.cwd(), "docs/readme-parity.json"), root = process.cwd() } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifestShape(manifest);
  await validateCanonicalEvidence({ manifest, root });
  const reports = [];
  for (const locale of manifest.locales) {
    const filePath = join(root, locale.file);
    const markdown = await readFile(filePath, "utf8");
    const headings = markdownHeadings(markdown).map((item) => item.heading);
    if (!documentTitles(markdown).includes(locale.title)) throw new Error(`${locale.file} title mismatch`);
    const top = markdown.split(/\r?\n/u).slice(0, 45).join("\n");
    for (const target of locale.languageSwitch) if (!top.includes(target)) throw new Error(`${locale.file} top language switch missing: ${target}`);
    for (const pattern of locale.forbiddenPatterns) if (markdown.includes(pattern)) throw new Error(`${locale.file} stale-summary pattern: ${pattern}`);
    for (const section of manifest.sections) {
      const allowed = section.headings[locale.id];
      if (!allowed.some((heading) => headings.includes(normalizeHeading(heading)))) throw new Error(`${locale.file} required section missing: ${section.id}`);
    }
    const numbersHeadings = manifest.sections.find(({ id }) => id === "numbers")?.headings[locale.id].map(normalizeHeading) ?? [];
    const numbers = sectionText(markdown, numbersHeadings);
    if (!numbers) throw new Error(`${locale.file} numbers section missing`);
    const chartFiles = [...numbers.matchAll(/!\[[^\]]+\]\(docs\/benchmarks\/([^\)]+\.svg)\)/gu)].map((match) => match[1]);
    const expectedChartFiles = manifest.evidence.expectedCharts.map(({ file }) => file);
    if (JSON.stringify(chartFiles) !== JSON.stringify(expectedChartFiles)) throw new Error(`${locale.file} README chart set/order mismatch`);
    for (const forbidden of manifest.evidence.forbiddenReadmeCharts) if (numbers.includes(forbidden)) throw new Error(`${locale.file} diagnostic chart promoted into README: ${forbidden}`);
    for (const metric of manifest.metricSections) {
      const body = sectionText(markdown, metric.headings[locale.id].map(normalizeHeading));
      if (!body) throw new Error(`${locale.file} metric section missing: ${metric.id}`);
      for (const token of metric.requiredTokens) if (!body.includes(token)) throw new Error(`${locale.file} ${metric.id} value missing: ${token}`);
      if (!body.includes(`(${metric.evidenceLink})`)) throw new Error(`${locale.file} metric evidence link missing: ${metric.evidenceLink}`);
      if (!body.includes(`(docs/benchmarks/${metric.chartFile})`)) throw new Error(`${locale.file} metric chart link missing: ${metric.chartFile}`);
    }
    for (const command of manifest.requiredCommands) if (!markdown.includes(command)) throw new Error(`${locale.file} required command missing: ${command}`);
    for (const link of manifest.requiredLinks) if (!markdown.includes(`(${link})`)) throw new Error(`${locale.file} canonical link missing: ${link}`);
    for (const status of manifest.evidence.requiredReadmeStatuses) if (!numbers.includes(status)) throw new Error(`${locale.file} evidence status missing: ${status}`);
    for (const boundary of locale.boundaryTokens) if (!numbers.includes(boundary)) throw new Error(`${locale.file} evidence boundary missing: ${boundary}`);
    await assertLocalLinks({ filePath, markdown, root });
    reports.push({ file: locale.file, headings: headings.length, locale: locale.id, status: "PASS" });
  }
  return { locales: reports, schemaVersion: manifest.schemaVersion, status: "PASS" };
}

async function main() {
  const result = await validateReadmeParity();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
