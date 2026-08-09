#!/usr/bin/env node
// verify-batteries — run the workspace verification batteries nothing else runs.
//
// Muse-owned packages/*/scripts/verify-*.mjs are deterministic, offline checks of integration
// formats. The AttuneGraph gitlink owns its internal qualification in standalone CI: Muse supports
// Node 22 while the reviewed local SQLite profile requires Node 24.15, so running the core's
// internal batteries here would make the host gate depend on a profile it does not advertise.
//
// Known failures are declared rather than skipped. A battery in BASELINE is reported and does not
// fail the gate; a battery NOT in it that fails does; and a baseline entry that starts passing
// fails too, so the list cannot quietly become a graveyard. The current baseline is intentionally
// empty: resolved batteries are ratcheted below and may not be silently exempted again.
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const BATTERY_TIMEOUT_MS = 120_000;

export const BASELINE = new Map();

export const INDEPENDENT_PACKAGE_PREFIXES = Object.freeze([
  "packages/attunegraph/",
]);

/** Every Muse-owned workspace battery, discovered rather than listed. */
export function discoverBatteries() {
  return execFileSync(
    "git",
    ["ls-files", "--recurse-submodules", "--", "packages/*/scripts/verify-*.mjs"],
    { cwd: ROOT, encoding: "utf8" }
  ).split("\n").filter(Boolean)
    .filter((battery) =>
      !battery.endsWith(".test.mjs")
      && !INDEPENDENT_PACKAGE_PREFIXES.some((prefix) => battery.startsWith(prefix)))
    .sort();
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

export function firstFailedWorkspace(workspaces, build) {
  for (const workspace of workspaces) {
    if (!build(workspace)) return workspace;
  }
  return undefined;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const batteries = discoverBatteries();
  const failedWorkspace = firstFailedWorkspace(
    owningWorkspaces(batteries),
    (workspace) => run("pnpm", ["--filter", `./${workspace}`, "build"]),
  );
  if (failedWorkspace) {
    process.stderr.write(`\n✗ ${failedWorkspace} failed to build; package batteries were not run.\n`);
    process.exit(1);
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
