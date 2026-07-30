import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(here, "check-doc-sections.mjs");

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-docsec-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const TARGET = "# T\n\n## 1. First\n\n## 2. Second\n\n## 3.6 Nested\n";
const run = (dir) => spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });

test("a section that exists passes", () => {
  const dir = repoWith({ ".claude/a.md": "see [t](t.md) §2\n", ".claude/t.md": TARGET });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// The rot: renumbering a document silently redirects every deep link into it.
test("a section that does not exist fails and lists what does", () => {
  const result = run(repoWith({ ".claude/a.md": "see [t](t.md) §9\n", ".claude/t.md": TARGET }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /t\.md has no §9 \(it has 1, 2, 3\.6\)/u);
});

test("a nested number resolves", () => {
  const dir = repoWith({ ".claude/a.md": "see [t](t.md) §3.6\n", ".claude/t.md": TARGET });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("the label-side shape is checked", () => {
  const result = run(repoWith({ ".claude/a.md": "see [t §9](t.md)\n", ".claude/t.md": TARGET }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /has no §9/u);
});

test("the code-span shape is checked", () => {
  const result = run(repoWith({ ".claude/a.md": "per `t.md` §9 do it\n", ".claude/t.md": TARGET }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /has no §9/u);
});

// A loose same-line association read "(contract §6). History: [CHANGELOG.md](CHANGELOG.md)"
// as a claim about the changelog. The mark must be ADJACENT to what it qualifies.
test("a section mark belonging to another document is not misattributed", () => {
  const dir = repoWith({
    ".claude/a.md": "(other §9). History: [log](log.md).\n",
    ".claude/log.md": TARGET,
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// A changelog numbers releases, not sections; 3.1.0 is not §3.
test("a target that numbers releases rather than sections is skipped", () => {
  const dir = repoWith({
    ".claude/a.md": "see [log](log.md) §2\n",
    ".claude/log.md": "# Changelog\n\n## 3.1.0\n\n## 2.0.0\n",
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// Scope lock: a historical record cited a section that existed when it was written.
test("a stale section reference in a non-normative record is not flagged", () => {
  const dir = repoWith({
    "internal/goals/backlog-archive.md": "did it per [t](../../.claude/t.md) §9\n",
    ".claude/t.md": TARGET,
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("an unresolvable target is left to check-doc-links", () => {
  const dir = repoWith({ ".claude/a.md": "see [gone](gone.md) §9\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});
