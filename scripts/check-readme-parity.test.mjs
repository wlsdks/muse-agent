import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { documentTitles, validateManifestShape, validateReadmeParity } from "./check-readme-parity.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("README parity recognizes Markdown and HTML h1 titles", () => {
  assert.deepEqual(documentTitles("# Muse\n\n<h1 align=\"center\">Muse 日本語</h1>"), ["Muse", "Muse 日本語"]);
});

test("repository README parity manifest passes for the canonical English README", async () => {
  const result = await validateReadmeParity({
    manifestPath: join(repoRoot, "docs/readme-parity.json"),
    root: repoRoot,
  });

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.locales.map(({ locale }) => locale), ["en"]);
});

test("README parity manifest closes the two-chart set and the evidence boundaries", async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, "docs/readme-parity.json"), "utf8"));
  validateManifestShape(manifest);
  assert.deepEqual(manifest.evidence.expectedCharts, [
    { file: "readme-qualified-grounding-v1.svg", status: "QUALIFIED_CONTROLLED_COMPONENT" },
    { file: "readme-controlled-scale-v1.svg", status: "QUALIFIED_CONTROLLED_SYNTHETIC_INTEGRITY" }
  ]);
  assert.equal(manifest.metricSections.length, 2);
  for (const locale of manifest.locales) assert.equal(locale.boundaryTokens.length, 3, locale.id);
  const openManifest = structuredClone(manifest);
  openManifest.evidence.expectedCharts.pop();
  assert.throws(() => validateManifestShape(openManifest), /exactly two charts/u);
});

test("README parity manifest rejects unknown root fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-readme-parity-"));
  try {
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: "muse-readme-parity.v2", unexpected: true }), "utf8");
    await assert.rejects(() => validateReadmeParity({ manifestPath, root }), /manifest fields mismatch/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
