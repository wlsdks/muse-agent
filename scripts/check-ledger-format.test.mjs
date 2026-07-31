import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const CHECKER = path.join(ROOT, "scripts/check-ledger-format.mjs");

/** Run the real checker against a disposable pair of ledgers. */
function check(backlog, archive = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "muse-ledger-"));
  mkdirSync(path.join(dir, "internal/goals"), { recursive: true });
  writeFileSync(path.join(dir, "internal/goals/backlog.md"), backlog);
  writeFileSync(path.join(dir, "internal/goals/backlog-archive.md"), archive);
  const run = spawnSync(process.execPath, [CHECKER], { cwd: dir, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return run;
}

test("a well-formed record passes", () => {
  const run = check("- [open] 2026-07-31 src=probe prio=3 for=maintenance :: text\n");
  assert.equal(run.status, 0, run.stderr);
});

// kind= was the only closed set anyone checked, though the README declares three. Three records
// written the day after that README was read carried src=<a skill name>, which matches none of
// the real sources an analysis grep looks for — documented-but-unenforced drifts.
test("every declared closed set is enforced, not just kind=", () => {
  for (const [field, bad] of [["kind", "chore"], ["src", "muse-dev-patterns"], ["for", "someone"]]) {
    const run = check(`- [open] 2026-07-31 ${field}=${bad} :: text\n`);
    assert.equal(run.status, 1, `${field}=${bad} must be rejected`);
    assert.match(run.stderr, new RegExp(`${field}='${bad}' outside the closed set`, "u"));
  }
});

test("an independent-evaluator finding is a legal source", () => {
  assert.equal(check("- [open] 2026-07-31 src=evaluator :: text\n").status, 0);
});

test("the shipped ledgers satisfy their own grammar", () => {
  const run = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

// The README is the human-facing copy of these sets and drifted behind the gate by four kinds.
// A first version asked only whether each gate value appeared ANYWHERE in the README, which
// `scout` satisfies from prose alone — it stayed green when the declaration was emptied, and
// when the gate lost a value the README still promised. This parses both declarations and
// compares the sets in both directions.
test("the README declares exactly the vocabulary the gate enforces", async () => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(path.join(ROOT, "internal/goals/README.md"), "utf8");
  const source = readFileSync(CHECKER, "utf8");
  for (const [constant, field] of [["KINDS", "kind"], ["SOURCES", "src"], ["OWNERS", "for"]]) {
    const declared = new RegExp(`const ${constant} = new Set\\(\\[([^\\]]*)\\]`, "u").exec(source);
    assert.ok(declared, `${constant} is no longer a literal set the README can be checked against`);
    const enforced = declared[1].split(",").map((item) => item.trim().replace(/"/gu, "")).filter(Boolean);
    const documented = new RegExp(`\`${field}=<([^>]*)>\``, "u").exec(readme);
    assert.ok(documented, `the README no longer declares ${field}=<...>`);
    assert.deepEqual(
      documented[1].split("|").map((item) => item.trim()).sort(),
      [...enforced].sort(),
      `the README's ${field} set and the gate's ${constant} disagree`,
    );
  }
});

// The bypass an evaluator found: only the first occurrence of a field was read, so a legal value
// in front of an illegal one passed the gate silently.
test("a repeated field cannot hide an illegal value behind a legal one", () => {
  for (const field of ["kind", "src", "for"]) {
    const legal = { kind: "fix", src: "probe", for: "maintenance" }[field];
    const run = check(`- [open] 2026-07-31 ${field}=${legal} ${field}=illegal :: text\n`);
    assert.equal(run.status, 1, `${field} repeated must still be checked`);
    assert.match(run.stderr, new RegExp(`${field}='illegal' outside the closed set`, "u"));
  }
});
