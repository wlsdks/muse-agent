import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = process.cwd();
const coreRoot = join(root, "packages/attunegraph");
const integrationRoot = join(root, "packages/muse-attunegraph");
const coreExports = [".", "./admin", "./backend", "./local", "./testing", "./extension-kit"];
const integrationExports = [
  "./continuity", "./continuity-changes", "./continuity-observations", "./continuity-capsules",
  "./continuity-resume-runtime", "./shadow-decision-receipt", "./loop-lineage"
];
const integrationDependencies = ["@attunegraph/core", "@muse/attunement", "@muse/shared"];
const legacyPackage = join("packages", ["attunement", "graph"].join("-"));

function gitFiles(path) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", path], { cwd: root, encoding: "buffer" })
    .toString("utf8").split("\0").filter(Boolean);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageFiles(packageRoot) {
  return gitFiles(relative(root, packageRoot)).filter((path) => /\/(src|scripts)\//.test(path));
}

export function assertAttuneGraphBoundary({ workspaceRoot = root } = {}) {
  const core = json(join(workspaceRoot, "packages/attunegraph/package.json"));
  const integration = json(join(workspaceRoot, "packages/muse-attunegraph/package.json"));
  assert.equal(core.name, "@attunegraph/core");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.keys(core[field] ?? {}).length, 0, `core ${field} must be empty`);
  }
  assert.deepEqual(Object.keys(core.exports ?? {}).sort(), [...coreExports].sort(), "core public exports changed");
  assert.equal(integration.name, "@muse/attunegraph");
  assert.equal(Object.hasOwn(integration.exports ?? {}, "."), false, "integration must not expose a root aggregate");
  assert.deepEqual(Object.keys(integration.exports ?? {}).sort(), [...integrationExports].sort(), "integration public exports changed");
  assert.deepEqual(Object.keys(integration.dependencies ?? {}).sort(), [...integrationDependencies].sort(), "integration dependencies changed");
  const coreConfig = json(join(workspaceRoot, "packages/attunegraph/tsconfig.json"));
  assert.deepEqual(coreConfig.references ?? [], [], "core TypeScript references must be empty");
  assert.equal(existsSync(join(workspaceRoot, legacyPackage)), false, "superseded package path remains");

  const coreFiles = gitFiles("packages/attunegraph");
  for (const path of coreFiles) {
    if (!/\.(?:[cm]?js|tsx?)$/.test(path)) continue;
    const content = readFileSync(join(workspaceRoot, path), "utf8");
    assert.doesNotMatch(content, /@muse\//, `${path} reaches a Muse package`);
    assert.doesNotMatch(content, /packages\/muse-attunegraph|\.\.\/muse-attunegraph/, `${path} reaches integration by path`);
  }
  const localCore = packageFiles(join(workspaceRoot, "packages/attunegraph")).map((path) => path.replace("packages/attunegraph/", ""));
  const localIntegration = packageFiles(join(workspaceRoot, "packages/muse-attunegraph")).map((path) => path.replace("packages/muse-attunegraph/", ""));
  const duplicates = localCore.filter((path) => localIntegration.includes(path));
  assert.deepEqual(duplicates, [], "implementation/test/script appears in both packages");
  assert.equal(localCore.length, 70, "core src/script split ledger changed");
  assert.equal(localIntegration.length, 63, "integration src/script split ledger changed");
  assert.equal(gitFiles("packages/attunegraph").length, 84, "core package ledger changed");
  assert.equal(gitFiles("packages/muse-attunegraph").length, 68, "integration package ledger changed");
}

test("AttuneGraph package boundary is neutral and acyclic", () => assertAttuneGraphBoundary());
