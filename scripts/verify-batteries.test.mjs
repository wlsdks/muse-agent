import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  BASELINE,
  INDEPENDENT_PACKAGE_PREFIXES,
  classify,
  discoverBatteries,
  firstFailedWorkspace,
  owningWorkspaces,
} from "./verify-batteries.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// Listing batteries by hand is how six of them came to have no caller at all. Discovery means a
// battery is covered the moment it exists, without anyone remembering to register it.
test("every Muse-owned workspace battery on disk is discovered", () => {
  const found = discoverBatteries();
  const tracked = execFileSync(
    "git",
    ["ls-files", "--recurse-submodules", "--", "packages/*/scripts/verify-*.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\n").filter(Boolean).sort();
  const expected = tracked.filter(
    (battery) =>
      !battery.endsWith(".test.mjs")
      && !INDEPENDENT_PACKAGE_PREFIXES.some((prefix) => battery.startsWith(prefix)),
  );
  assert.deepEqual(found, expected);
  assert.ok(
    found.some((battery) => battery.startsWith("packages/muse-attunegraph/scripts/")),
    "Muse integration batteries must remain discovered",
  );
});

test("test modules are not executed directly as batteries", () => {
  const found = new Set(discoverBatteries());
  const testModules = execFileSync(
    "git",
    ["ls-files", "--recurse-submodules", "--", "packages/*/scripts/verify-*.test.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\n").filter(Boolean);
  assert.ok(testModules.length > 0, "expected tracked verifier test modules");
  for (const testModule of testModules) {
    assert.equal(found.has(testModule), false, `${testModule} must run through node:test, not as a battery`);
  }
});

test("standalone AttuneGraph remains present and owns an executable CI qualification boundary", () => {
  const found = new Set(discoverBatteries());
  const tracked = execFileSync(
    "git",
    ["ls-files", "--recurse-submodules", "--", "packages/*/scripts/verify-*.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\n").filter(Boolean)
    .filter((battery) => battery.startsWith("packages/attunegraph/scripts/"))
    .sort();
  assert.deepEqual(INDEPENDENT_PACKAGE_PREFIXES, ["packages/attunegraph/"]);
  assert.deepEqual(tracked, [
    "packages/attunegraph/scripts/verify-attunegraph-local.mjs",
    "packages/attunegraph/scripts/verify-attunegraph-performance-regression.mjs",
    "packages/attunegraph/scripts/verify-attunegraph-performance-regression.test.mjs",
    "packages/attunegraph/scripts/verify-attunegraph-portable-fixtures.mjs",
    "packages/attunegraph/scripts/verify-candidate-settlement-ledger.mjs",
    "packages/attunegraph/scripts/verify-canonical-immutable-envelope.mjs",
    "packages/attunegraph/scripts/verify-clean-room-consumer.mjs",
    "packages/attunegraph/scripts/verify-working-graph-golden-corpus.mjs",
    "packages/attunegraph/scripts/verify-working-graph-golden-corpus.test.mjs",
  ]);
  for (const battery of tracked) {
    assert.equal(found.has(battery), false, `${battery} belongs to the standalone package boundary`);
  }
  const packageRoot = join(ROOT, "packages/attunegraph");
  const workflowPath = join(packageRoot, ".github/workflows/ci.yml");
  const packageJsonPath = join(packageRoot, "package.json");
  assert.equal(existsSync(workflowPath), true, "standalone CI must remain inspectable");
  assert.equal(existsSync(packageJsonPath), true, "standalone package scripts must remain inspectable");

  const workflow = readFileSync(workflowPath, "utf8");
  const packageScripts = JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts;
  const requiredQualification = [
    "check:naming",
    "typecheck",
    "test:focused",
    "test:performance",
    "test:readiness",
    "verify:working-graph-golden",
    "verify:clean-room-consumer",
    "test:cross-platform",
    "test:local-profile",
  ];
  for (const script of requiredQualification) {
    assert.equal(
      typeof packageScripts[script],
      "string",
      `standalone qualification script ${script} must remain declared`,
    );
    assert.match(
      workflow,
      new RegExp(
        `^\\s+(?:- )?run: pnpm ${script.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
        "mu",
      ),
      `standalone CI must execute pnpm ${script}`,
    );
  }
  for (const job of [
    "core-compatibility",
    "readiness-contract",
    "clean-room-consumer",
    "cross-platform",
    "local-profile",
  ]) {
    assert.match(workflow, new RegExp(`^  ${job}:$`, "mu"), `${job} CI job must remain declared`);
  }
  assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/u);
  assert.match(workflow, /os: \[ubuntu-latest, macos-15-intel\]/u);
});

test("each baseline entry names a battery that exists, with a dated reason", () => {
  for (const [battery, reason] of BASELINE) {
    assert.ok(existsSync(join(ROOT, battery)), `${battery} is listed but absent`);
    assert.match(reason, /^\d{4}-\d{2}-\d{2}: /u, `${battery} needs a dated reason`);
  }
});

test("resolved canonical digest batteries cannot return to the baseline", () => {
  for (const battery of [
    "packages/muse-attunegraph/scripts/verify-fair-frontier-bundle-order.mjs",
    "packages/muse-attunegraph/scripts/verify-fair-witness-frontier-settlement.mjs",
    "packages/muse-attunegraph/scripts/verify-thread-rooted-witness-documents.mjs",
  ]) {
    assert.equal(BASELINE.has(battery), false, `${battery} must remain release-blocking`);
  }
});

test("ordinary Linux CI runs package batteries after the workspace build", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const linuxJob = workflow.slice(
    workflow.indexOf("  check:\n"),
    workflow.indexOf("  check-windows:\n"),
  );
  const build = linuxJob.indexOf("- run: pnpm check");
  const batteries = linuxJob.indexOf("- run: pnpm verify:packages");
  assert.ok(build >= 0, "ordinary Linux CI must build the workspace");
  assert.ok(batteries > build, "package batteries must reuse and follow the workspace build");
});

test("an unlisted failure is the gate's whole point", () => {
  const { broke, known, passed } = classify(
    [{ battery: "a", ok: false }, { battery: "b", ok: true }],
    new Map(),
  );
  assert.deepEqual(broke, ["a"]);
  assert.deepEqual(passed, ["b"]);
  assert.deepEqual(known, []);
});

test("a listed failure is reported without failing the gate", () => {
  const baseline = new Map([["a", "2026-07-31: reason"]]);
  const { broke, known } = classify([{ battery: "a", ok: false }], baseline);
  assert.deepEqual(known, ["a"]);
  assert.deepEqual(broke, [], "a declared failure must not be a new one");
});

// Without this the list becomes a graveyard: the entry outlives the bug, and the next real
// failure in that battery is waved through as already known.
test("a listed battery that starts passing fails until it leaves the list", () => {
  const baseline = new Map([["a", "2026-07-31: reason"]]);
  const { fixed, passed } = classify([{ battery: "a", ok: true }], baseline);
  assert.deepEqual(fixed, ["a"]);
  assert.deepEqual(passed, [], "it is not simply a pass — the list has to shrink");
});

test("each owning workspace is built once, not once per battery", () => {
  assert.deepEqual(
    owningWorkspaces([
      "packages/x/scripts/verify-a.mjs",
      "packages/x/scripts/verify-b.mjs",
      "packages/y/scripts/verify-c.mjs",
    ]),
    ["packages/x", "packages/y"],
  );
});

test("a workspace build failure stops before later builds or package batteries", () => {
  const attempted = [];
  const failed = firstFailedWorkspace(["packages/a", "packages/b", "packages/c"], (workspace) => {
    attempted.push(workspace);
    return workspace !== "packages/b";
  });
  assert.equal(failed, "packages/b");
  assert.deepEqual(attempted, ["packages/a", "packages/b"]);
});
