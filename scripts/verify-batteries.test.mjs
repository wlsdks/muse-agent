import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BASELINE,
  NON_BATTERIES,
  classify,
  discoverBatteries,
  owningWorkspaces,
} from "./verify-batteries.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// Listing batteries by hand is how six of them came to have no caller at all. Discovery means a
// battery is covered the moment it exists, without anyone remembering to register it.
test("every workspace battery on disk is discovered", () => {
  const found = discoverBatteries();
  const tracked = execFileSync(
    "git",
    ["ls-files", "--recurse-submodules", "--", "packages/*/scripts/verify-*.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\n").filter(Boolean).sort();
  const expected = tracked.filter(
    (battery) => !battery.endsWith(".test.mjs") && !NON_BATTERIES.has(battery),
  );
  assert.deepEqual(found, expected);
  assert.ok(found.some((battery) => battery.startsWith("packages/attunegraph/scripts/")), "tracked AttuneGraph submodule batteries must be discovered");
  assert.ok(found.length >= 12, `expected the AttuneGraph batteries, got ${found.length}`);
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

test("each explicit non-battery entry proves its no-argument failure contract", () => {
  const found = new Set(discoverBatteries());
  const tracked = new Set(execFileSync(
    "git",
    ["ls-files", "--recurse-submodules", "--", "packages/*/scripts/verify-*.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\n").filter(Boolean));
  assert.ok(
    NON_BATTERIES.has("packages/attunegraph/scripts/verify-attunegraph-performance-regression.mjs"),
    "the --manifest performance verifier must stay classified as a non-battery",
  );
  for (const [nonBattery, contract] of NON_BATTERIES) {
    assert.deepEqual(Object.keys(contract).sort(), ["noArgumentFailure", "reason"]);
    assert.deepEqual(
      Object.keys(contract.noArgumentFailure).sort(),
      ["blocker", "exitCode", "schema"],
    );
    assert.ok(existsSync(path.join(ROOT, nonBattery)), `${nonBattery} is listed but absent`);
    assert.ok(tracked.has(nonBattery), `${nonBattery} is listed but untracked`);
    assert.equal(found.has(nonBattery), false, `${nonBattery} must not run as a battery`);
    assert.match(contract.reason, /^\d{4}-\d{2}-\d{2}: /u, `${nonBattery} needs a dated reason`);
    assert.ok(
      Number.isInteger(contract.noArgumentFailure.exitCode)
        && contract.noArgumentFailure.exitCode > 0,
      `${nonBattery} needs a nonzero no-argument exit code`,
    );

    const result = spawnSync(process.execPath, [path.join(ROOT, nonBattery)], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined, `${nonBattery} must execute without a spawn error`);
    assert.equal(result.signal, null, `${nonBattery} must exit rather than receive a signal`);
    assert.equal(result.status, contract.noArgumentFailure.exitCode);
    assert.equal(result.stderr, "", `${nonBattery} must emit its structured rejection on stdout`);
    const rejection = JSON.parse(result.stdout);
    assert.equal(rejection.schema, contract.noArgumentFailure.schema);
    assert.deepEqual(rejection.blockers, [contract.noArgumentFailure.blocker]);
  }
});

test("each baseline entry names a battery that exists, with a dated reason", () => {
  for (const [battery, reason] of BASELINE) {
    assert.ok(existsSync(path.join(ROOT, battery)), `${battery} is listed but absent`);
    assert.match(reason, /^\d{4}-\d{2}-\d{2}: /u, `${battery} needs a dated reason`);
  }
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
