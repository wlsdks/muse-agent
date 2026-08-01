import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const corePath = "packages/attunegraph";
const coreSubmoduleUrl = "https://github.com/wlsdks/attunegraph.git";
const coreExports = [
  ".", "./admin", "./backend", "./local", "./readonly-working-graph",
  "./source-adapter", "./testing", "./extension-kit"
];
const integrationExports = [
  "./continuity", "./continuity-capsule-preparation", "./continuity-changes",
  "./continuity-observations", "./continuity-capsules",
  "./continuity-resume-runtime", "./continuity-durable-projection",
  "./continuity-shadow-returns", "./policy-card", "./shadow-decision-receipt", "./loop-lineage"
];
const integrationDependencies = [
  "@attunegraph/core", "@muse/attunement", "@muse/model", "@muse/shared"
];
const legacyPackage = join("packages", ["attunement", "graph"].join("-"));

function gitFiles(packageRoot) {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: packageRoot, encoding: "buffer" })
    .toString("utf8").split("\0").filter(Boolean);
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageFiles(packageRoot) {
  return gitFiles(packageRoot).filter((path) => /^(?:src|scripts)\//.test(path));
}

function assertInitializedCoreSubmodule(workspaceRoot) {
  const submoduleRoot = join(workspaceRoot, corePath);
  const gitlink = execFileSync("git", ["ls-files", "-s", "--", corePath], { cwd: workspaceRoot, encoding: "utf8" }).trim();
  assert.match(gitlink, /^160000 [0-9a-f]{40} 0\tpackages\/attunegraph$/u, "core must be an exact gitlink");
  assert.equal(existsSync(join(submoduleRoot, "package.json")), true, "core submodule must be initialized");
  assert.equal(
    execFileSync("git", ["-C", submoduleRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
    resolve(submoduleRoot),
    "core must be a nested Git worktree",
  );
  assert.equal(
    execFileSync("git", ["config", "--file", ".gitmodules", "--get", `submodule.${corePath}.url`], { cwd: workspaceRoot, encoding: "utf8" }).trim(),
    coreSubmoduleUrl,
    "core submodule URL changed",
  );
}

export function assertAttuneGraphBoundary({ workspaceRoot = root } = {}) {
  assertInitializedCoreSubmodule(workspaceRoot);
  const core = json(join(workspaceRoot, "packages/attunegraph/package.json"));
  const integration = json(join(workspaceRoot, "packages/muse-attunegraph/package.json"));
  assert.equal(core.name, "@attunegraph/core");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
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

  const coreFiles = gitFiles(join(workspaceRoot, corePath));
  for (const path of coreFiles) {
    if (!/\.(?:[cm]?js|tsx?)$/.test(path)) continue;
    const content = readFileSync(join(workspaceRoot, corePath, path), "utf8");
    let boundaryContent = content;
    if (path === "scripts/verify-clean-room-consumer.mjs") {
      for (const packedLeakSentinel of [
        '  "@muse/",\n',
        '  "packages/muse-attunegraph",\n'
      ]) {
        const withoutSentinel = boundaryContent.replace(packedLeakSentinel, "");
        assert.notEqual(withoutSentinel, boundaryContent, `missing packed leak sentinel in ${path}`);
        boundaryContent = withoutSentinel;
      }
    }
    assert.doesNotMatch(boundaryContent, /@muse\//, `${path} reaches a Muse package`);
    assert.doesNotMatch(boundaryContent, /packages\/muse-attunegraph|\.\.\/muse-attunegraph/, `${path} reaches integration by path`);
  }
  const localCore = packageFiles(join(workspaceRoot, corePath));
  const localIntegration = packageFiles(join(workspaceRoot, "packages/muse-attunegraph"));
  const duplicates = localCore.filter((path) => localIntegration.includes(path));
  assert.deepEqual(duplicates, [], "implementation/test/script appears in both packages");
  assert.equal(localIntegration.length, 79, "integration src/script split ledger changed");
  assert.equal(gitFiles(join(workspaceRoot, "packages/muse-attunegraph")).length, 84, "integration package ledger changed");
}

test("AttuneGraph package boundary is neutral and acyclic", () => assertAttuneGraphBoundary());
