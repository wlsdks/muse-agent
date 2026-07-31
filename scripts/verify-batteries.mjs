#!/usr/bin/env node
// verify-batteries — run the workspace verification batteries nothing else runs.
//
// packages/*/scripts/verify-*.mjs are deterministic, offline, sub-second checks of the
// AttuneGraph canonical formats. Twelve exist; six were reachable through a `verify:*` script in
// their own package.json and six were reachable only by someone typing the path. Nothing ran any
// of them, so THREE had been failing silently — the same disease self-eval already records twice
// ("a guard nobody runs is not a guard"), found a third time.
//
// Known failures are declared rather than skipped. A battery in BASELINE is reported and does not
// fail the gate; a battery NOT in it that fails does; and a baseline entry that starts passing
// fails too, so the list cannot quietly become a graveyard.
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const BATTERY_TIMEOUT_MS = 120_000;

/**
 * Failing on the day this runner landed, with the reason. Each is one divergence: the battery
 * recomputes a canonical content id independently and disagrees with the module it checks, so
 * one of the two canonicalisations moved after `8f75070f9` and the other did not. Which side is
 * correct is an AttuneGraph decision about a persisted format — guessing a digest would defeat
 * the pin — so they are declared here and recorded in the backlog for that package's owner.
 */
export const BASELINE = new Map([
  ["packages/muse-attunegraph/scripts/verify-fair-frontier-bundle-order.mjs",
    "2026-07-31: independent request-digest disagrees with fair-frontier-bundle-order.ts"],
  ["packages/muse-attunegraph/scripts/verify-fair-witness-frontier-settlement.mjs",
    "2026-07-31: independent receipt-digest disagrees with fair-witness-frontier-settlement.ts"],
  ["packages/muse-attunegraph/scripts/verify-thread-rooted-witness-documents.mjs",
    "2026-07-31: independent receipt-digest disagrees with thread-rooted-witness-documents.ts"],
]);

/** Every workspace battery, discovered rather than listed, so a new one is covered on arrival. */
export function discoverBatteries() {
  return execFileSync(
    "git",
    ["ls-files", "--recurse-submodules", "--", "packages/*/scripts/verify-*.mjs"],
    { cwd: ROOT, encoding: "utf8" }
  ).split("\n").filter(Boolean).sort();
}

/**
 * Split results against the baseline. `fixed` is a failure too: a battery that starts passing
 * must leave the list, or the next real failure there would be waved through as known.
 */
export function classify(results, baseline = BASELINE) {
  const passed = [];
  const known = [];
  const broke = [];
  const fixed = [];
  for (const { battery, ok } of results) {
    const listed = baseline.has(battery);
    if (ok && listed) fixed.push(battery);
    else if (ok) passed.push(battery);
    else if (listed) known.push(battery);
    else broke.push(battery);
  }
  return { passed, known, broke, fixed };
}

/** The workspaces owning batteries, so each is built once rather than once per battery. */
export function owningWorkspaces(batteries) {
  return [...new Set(batteries.map((battery) => battery.split("/").slice(0, 2).join("/")))].sort();
}

function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: "ignore", timeout: BATTERY_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const batteries = discoverBatteries();
  for (const workspace of owningWorkspaces(batteries)) {
    // The batteries import built output; an unbuilt workspace would read as a wall of failures.
    run("pnpm", ["--filter", `./${workspace}`, "build"]);
  }

  const results = batteries.map((battery) => {
    const started = Date.now();
    const ok = run(process.execPath, [path.join(ROOT, battery)]);
    return { battery, ok, ms: Date.now() - started };
  });
  const { passed, known, broke, fixed } = classify(results);

  for (const { battery, ok, ms } of results) {
    const mark = ok ? (BASELINE.has(battery) ? "FIXED" : "pass") : (BASELINE.has(battery) ? "known" : "FAIL");
    process.stdout.write(`  ${mark.padEnd(5)} ${String(ms).padStart(6)}ms  ${battery}\n`);
  }
  process.stdout.write(
    `[verify-batteries] ${passed.length} passed, ${known.length} known-failing, `
      + `${broke.length} newly failing, ${fixed.length} fixed-but-still-listed.\n`,
  );
  for (const battery of known) process.stdout.write(`  known: ${battery} — ${BASELINE.get(battery)}\n`);
  for (const battery of broke) process.stderr.write(`\n✗ ${battery} started failing.\n`);
  for (const battery of fixed) {
    process.stderr.write(`\n✗ ${battery} passes now — remove it from BASELINE in scripts/verify-batteries.mjs.\n`);
  }
  if (broke.length > 0 || fixed.length > 0) process.exit(1);
}
