import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { BASELINE, classify, discoverBatteries, owningWorkspaces } from "./verify-batteries.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// Listing batteries by hand is how six of them came to have no caller at all. Discovery means a
// battery is covered the moment it exists, without anyone remembering to register it.
test("every workspace battery on disk is discovered", () => {
  const found = discoverBatteries();
  const expected = execFileSync(
    "git",
    ["ls-files", "--", "packages/*/scripts/verify-*.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  ).split("\n").filter(Boolean).sort();
  assert.deepEqual(found, expected);
  assert.ok(found.length >= 12, `expected the AttuneGraph batteries, got ${found.length}`);
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
