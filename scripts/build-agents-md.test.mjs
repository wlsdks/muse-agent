import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_DEFAULT_DOC_BUDGET,
  checkBudget,
  codexDocBudget,
  compose,
  renderBlock,
  rewriteLinks,
  sourceFiles,
} from "./build-agents-md.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// Codex drops the tail of an over-budget project doc and says nothing. An 78 KB AGENTS.md lost
// outbound-safety.md, tool-calling.md and testing.md while every run still looked healthy.
test("an over-budget projection is reported, with the remedy", () => {
  const problem = checkBudget(78788, { budget: CODEX_DEFAULT_DOC_BUDGET, codexInstalled: true });
  assert.match(problem, /78788 bytes but codex reads at most 32768/u);
  assert.match(problem, /SILENTLY/u);
  assert.match(problem, /project_doc_max_bytes = \d+/u);
});

test("a projection that fits, or a machine without codex, reports nothing", () => {
  assert.equal(checkBudget(10, { budget: CODEX_DEFAULT_DOC_BUDGET, codexInstalled: true }), null);
  assert.equal(checkBudget(78788, { budget: CODEX_DEFAULT_DOC_BUDGET, codexInstalled: false }), null);
  assert.equal(checkBudget(78788, { budget: 200000, codexInstalled: true }), null);
});

test("the budget is read from the codex config, defaulting when absent", () => {
  assert.equal(codexDocBudget("model = \"x\"\nproject_doc_max_bytes = 200000\n"), 200000);
  assert.equal(codexDocBudget("model = \"x\"\n"), CODEX_DEFAULT_DOC_BUDGET);
  assert.equal(codexDocBudget(undefined), CODEX_DEFAULT_DOC_BUDGET);
});

test("a commented-out or table-scoped budget key does not count", () => {
  assert.equal(codexDocBudget("# project_doc_max_bytes = 200000\n"), CODEX_DEFAULT_DOC_BUDGET);
  // The real trap: appending the key to a config that ends in tables puts it inside the last
  // one, where codex ignores it. Reading it as the budget blesses a truncating config.
  assert.equal(
    codexDocBudget('[projects."/x"]\ntrust_level = "trusted"\nproject_doc_max_bytes = 200000\n'),
    CODEX_DEFAULT_DOC_BUDGET,
  );
});

test("a budget value that is not a plain integer falls back rather than passing", () => {
  assert.equal(codexDocBudget("project_doc_max_bytes = 200_000\n"), 200000);
  for (const value of ["0x30000", "2e5", '"200000"', "true"]) {
    assert.equal(codexDocBudget(`project_doc_max_bytes = ${value}\n`), CODEX_DEFAULT_DOC_BUDGET, value);
  }
});

test("a projection exactly at the budget is allowed, one byte over is not", () => {
  assert.equal(checkBudget(32768, { budget: 32768, codexInstalled: true }), null);
  assert.match(checkBudget(32769, { budget: 32768, codexInstalled: true }), /32769 bytes/u);
});

// git's default pathspec makes `**` require a literal slash, so `.claude/rules/**\/*.md` skipped
// any rule placed directly in .claude/rules/. Asserted against a disposable repo with a known
// layout — re-deriving the expectation with the same git call and the same filter cannot fail.
test("every markdown rule is collected, at any depth, and non-markdown is not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muse-src-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  mkdirSync(path.join(dir, ".claude/rules/deep/deeper"), { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# c\n");
  for (const rel of [".claude/rules/top.md", ".claude/rules/deep/mid.md",
    ".claude/rules/deep/deeper/low.md", ".claude/rules/notes.txt"]) {
    writeFileSync(path.join(dir, rel), "# x\n");
  }
  const listed = spawnSync(process.execPath, ["-e",
    `process.chdir(${JSON.stringify(dir)});`
    + `import(${JSON.stringify(path.join(ROOT, "scripts/build-agents-md.mjs"))})`
    + `.then((m) => process.stdout.write(JSON.stringify(m.sourceFiles())));`,
  ], { cwd: dir, encoding: "utf8" });
  assert.deepEqual(JSON.parse(listed.stdout), [
    "CLAUDE.md",
    ".claude/rules/deep/deeper/low.md",
    ".claude/rules/deep/mid.md",
    ".claude/rules/top.md",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("the source set is exactly what Claude Code auto-loads", () => {
  const files = sourceFiles();
  assert.equal(files[0], "CLAUDE.md");
  assert.ok(files.length >= 10, `expected CLAUDE.md plus the rules, got ${files.length}`);
  assert.ok(files.slice(1).every((f) => f.startsWith(".claude/rules/") && f.endsWith(".md")));
  assert.deepEqual(files.slice(1), [...files.slice(1)].sort(), "order must be deterministic");
});

// A link written in .claude/rules/verification/ resolves against that directory. Inlined at
// the root it would point somewhere else — this is the transform that keeps it honest.
test("a relative link is re-expressed from the repo root", () => {
  assert.equal(
    rewriteLinks("see [x](agent-testing.md)", ".claude/rules/verification"),
    "see [x](.claude/rules/verification/agent-testing.md)",
  );
  assert.equal(
    rewriteLinks("see [x](../../../docs/a.md)", ".claude/rules/verification"),
    "see [x](docs/a.md)",
  );
});

// A backticked bare path is a citation, not a link. check-doc-links resolves those too, and
// four of them pointed at the source directory until this pass existed.
test("a backticked relative path that resolves is rewritten", () => {
  assert.equal(
    rewriteLinks("see `../safety/outbound-safety.md` first", ".claude/rules/engineering"),
    "see `.claude/rules/safety/outbound-safety.md` first",
  );
});

test("a backticked path that resolves to nothing is left alone", () => {
  const shell = "run `../scripts/does-not-exist.sh`";
  assert.equal(rewriteLinks(shell, ".claude/rules"), shell);
  assert.equal(rewriteLinks("`cd ..` then build", ".claude/rules"), "`cd ..` then build");
});

test("a fragment survives the rewrite", () => {
  assert.equal(
    rewriteLinks("[x](testing.md#gates)", ".claude/rules/verification"),
    "[x](.claude/rules/verification/testing.md#gates)",
  );
});

// A bare #fragment resolves inside AGENTS.md because the heading it names is inlined too.
test("urls, absolute paths and bare fragments are left alone", () => {
  for (const target of ["https://x.dev/a", "mailto:a@b.c", "/abs/p.md", "#appendix"]) {
    assert.equal(rewriteLinks(`[x](${target})`, ".claude/rules"), `[x](${target})`);
  }
});

test("every source file's text lands in the block verbatim", () => {
  const block = renderBlock();
  for (const file of sourceFiles()) {
    const body = readFileSync(`${ROOT}/${file}`, "utf8").trimEnd();
    // The first heading is a cheap, link-free anchor for "this file is actually present".
    const heading = body.split("\n").find((line) => line.startsWith("# "));
    assert.ok(block.includes(`<!-- source: ${file} -->`), `missing marker for ${file}`);
    if (heading) assert.ok(block.includes(heading), `missing content of ${file}`);
  }
});

test("regenerating replaces the block rather than appending a second one", () => {
  const once = compose("intro\n", "<<BLOCK>>");
  assert.match(once, /intro/u);
  const composed = compose(
    `intro\n\n${renderBlock()}\n\ntail\n`,
    renderBlock(),
  );
  assert.equal(composed.split("<!-- END GENERATED -->").length - 1, 1);
  assert.match(composed, /tail/u);
});

test("a BEGIN with no END is an error, not a silent overwrite", () => {
  const begin = renderBlock().split("\n")[0];
  assert.throws(() => compose(`a\n${begin}\nb\n`, "x"), /no END marker/u);
});

// The gate this file exists for. It runs the real CLI in a disposable repo and asserts the
// EXIT CODE: an earlier version of this test re-implemented the comparison in a subprocess, so
// mutating process.exit(1) to exit(0) in the --check branch left the whole suite green.
test("the --check CLI exits 1 on a stale projection and 0 on a current one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muse-agents-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  mkdirSync(path.join(dir, ".claude/rules/engineering"), { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# c\n\nCONTRACT_LINE\n");
  writeFileSync(path.join(dir, ".claude/rules/engineering/a.md"), "# a\n\nRULE_LINE\n");
  writeFileSync(path.join(dir, "AGENTS.md"), "# brief\n\nintro\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });

  const cli = (...args) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/build-agents-md.mjs"), ...args], {
      cwd: dir,
      encoding: "utf8",
    });

  assert.equal(cli("--check").status, 1, "an unprojected AGENTS.md must fail --check");
  assert.equal(cli().status, 0);
  const built = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(built.includes("CONTRACT_LINE") && built.includes("RULE_LINE"), "content must land");
  assert.equal(cli("--check").status, 0, "a freshly built AGENTS.md must pass --check");

  writeFileSync(path.join(dir, ".claude/rules/engineering/a.md"), "# a\n\nRULE_LINE CHANGED\n");
  assert.equal(cli("--check").status, 1, "an edited rule must stale the projection");
  rmSync(dir, { recursive: true, force: true });
});
