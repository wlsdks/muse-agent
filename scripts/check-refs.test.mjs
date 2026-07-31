import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(here, "check-refs.mjs");

function repoWith(projects) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-refs-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  for (const [rel, { pkg, tsconfig }] of Object.entries(projects)) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    fs.writeFileSync(path.join(dir, rel, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    if (tsconfig) fs.writeFileSync(path.join(dir, rel, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const composite = (references = []) => ({ compilerOptions: { composite: true }, include: ["src/**/*.ts"], references });
const run = (dir) => spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });

test("a dependency that is also a reference passes", () => {
  const dir = repoWith({
    "packages/leaf": { pkg: { name: "@muse/leaf" }, tsconfig: composite() },
    "packages/app": { pkg: { name: "@muse/app", dependencies: { "@muse/leaf": "workspace:*" } }, tsconfig: composite([{ path: "../leaf" }]) },
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("an initialized on-disk workspace manifest is discovered even before its gitlink is staged", () => {
  const dir = repoWith({
    "packages/app": { pkg: { name: "@muse/app", dependencies: { "@muse/leaf": "workspace:*" } }, tsconfig: composite([{ path: "../leaf" }]) },
  });
  fs.mkdirSync(path.join(dir, "packages/leaf"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages/leaf/package.json"), `${JSON.stringify({ name: "@muse/leaf" }, null, 2)}\n`);
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a dependency with no reference fails and names the fix", () => {
  const result = run(repoWith({
    "packages/leaf": { pkg: { name: "@muse/leaf" }, tsconfig: composite() },
    "packages/app": { pkg: { name: "@muse/app", dependencies: { "@muse/leaf": "workspace:*" } }, tsconfig: composite() },
  }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /packages\/app: depends on @muse\/leaf but tsconfig\.json has no reference/u);
  assert.match(result.stdout, /"path": "\.\.\/leaf"/u);
});

// The whole point: the seven real cases were all devDependencies imported only from test/,
// which `include: ["src/**/*.ts"]` hides from tsc, so the build silently skips the dep and
// vitest resolves a stale dist. A deps-only check would have found none of them.
test("a devDependency counts — that is the stale-dist case", () => {
  const result = run(repoWith({
    "packages/leaf": { pkg: { name: "@muse/leaf" }, tsconfig: composite() },
    "packages/app": { pkg: { name: "@muse/app", devDependencies: { "@muse/leaf": "workspace:*" } }, tsconfig: composite() },
  }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /depends on @muse\/leaf/u);
});

test("an external dependency is not a project reference", () => {
  const dir = repoWith({
    "packages/app": { pkg: { name: "@muse/app", dependencies: { zod: "^3", "@types/node": "^22" } }, tsconfig: composite() },
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// apps/web is deliberately outside the reference graph, so the gate keys on composite,
// never on a name allowlist that would silently stop covering a renamed app.
test("a non-composite project is exempt", () => {
  const dir = repoWith({
    "packages/leaf": { pkg: { name: "@muse/leaf" }, tsconfig: composite() },
    "apps/web": { pkg: { name: "@muse/web", dependencies: { "@muse/leaf": "workspace:*" } }, tsconfig: { compilerOptions: {}, include: ["src"] } },
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a project with no tsconfig is skipped", () => {
  const dir = repoWith({ "packages/thing": { pkg: { name: "@muse/thing", dependencies: { "@muse/gone": "workspace:*" } } } });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// A reference is resolved to the name its directory actually declares, so moving or
// renaming a package cannot leave a reference silently pointing at nothing.
test("a reference pointing at no workspace package fails", () => {
  const result = run(repoWith({
    "packages/app": { pkg: { name: "@muse/app" }, tsconfig: composite([{ path: "../ghost" }]) },
  }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /reference \.\.\/ghost resolves to no workspace package/u);
});

// The acyclic invariant outranks the both-places rule. packages/mcp devDepends on
// @muse/domain-tools, which depends back on mcp; adding that reference makes `tsc -b`
// fail with TS6202 — which is exactly how this gate's first version broke the build.
// The cycle is a deterministic fact of the manifests, so it is proven, not allowlisted.
test("a reference that would cycle is exempt, not demanded", () => {
  const dir = repoWith({
    "packages/a": { pkg: { name: "@muse/a", devDependencies: { "@muse/b": "workspace:*" } }, tsconfig: composite() },
    "packages/b": { pkg: { name: "@muse/b", dependencies: { "@muse/a": "workspace:*" } }, tsconfig: composite([{ path: "../a" }]) },
  });
  const result = run(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /1 exempt: referencing them would cycle/u);
});

test("an indirect cycle is exempt too", () => {
  const dir = repoWith({
    "packages/a": { pkg: { name: "@muse/a", devDependencies: { "@muse/c": "workspace:*" } }, tsconfig: composite() },
    "packages/b": { pkg: { name: "@muse/b", dependencies: { "@muse/a": "workspace:*" } }, tsconfig: composite([{ path: "../a" }]) },
    "packages/c": { pkg: { name: "@muse/c", dependencies: { "@muse/b": "workspace:*" } }, tsconfig: composite([{ path: "../b" }]) },
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});
