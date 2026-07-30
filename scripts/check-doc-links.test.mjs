import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(here, "check-doc-links.mjs");

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-doclinks-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });

test("a resolving link passes", () => {
  const dir = repoWith({ "a.md": "[b](b.md)\n", "b.md": "hi\n" });
  assert.equal(run(dir).status, 0);
});

test("a missing target fails", () => {
  const result = run(repoWith({ "a.md": "[gone](nope.md)\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing target nope\.md/u);
});

test("a missing #fragment fails", () => {
  const result = run(repoWith({ "a.md": "[x](b.md#nope)\n", "b.md": "## Real heading\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing anchor/u);
});

test("an em-dash heading yields the double-hyphen anchor GitHub generates", () => {
  const dir = repoWith({ "a.md": "[x](b.md#one--two)\n", "b.md": "## One — two\n" });
  assert.equal(run(dir).status, 0);
});

test("a link inside a code span is not a link", () => {
  const dir = repoWith({ "a.md": "the fixture is `![](exfil)` in the notes\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a link inside a fenced block is not a link", () => {
  const dir = repoWith({ "a.md": "```\n[x](nope.md)\n```\n" });
  assert.equal(run(dir).status, 0);
});

test("frontmatter related: as an inline sequence is checked", () => {
  const result = run(repoWith({ "a.md": "---\nrelated: [nope.md]\n---\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing frontmatter related nope\.md/u);
});

// The regression this suite exists for: a line-prefixed scan sees `related:` and
// stops, so every path in the block sequence below went unchecked. Fifteen broken
// references passed as clean the day the gate landed.
test("frontmatter related: as a block sequence is checked", () => {
  const result = run(repoWith({ "a.md": "---\nrelated:\n  - real.md\n  - nope.md\n---\n", "real.md": "hi\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing frontmatter related nope\.md/u);
  assert.doesNotMatch(result.stdout, /real\.md/u);
});

test("the block sequence ends at the next key rather than swallowing it", () => {
  const dir = repoWith({ "a.md": "---\nrelated:\n  - real.md\nupdated: nope.md\n---\n", "real.md": "hi\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// The false NEGATIVE this suite gained after the block-sequence one: code spans are
// stripped so `![](exfil)` is not treated as a link, which also made every backticked
// path citation invisible. Eleven citations of a deleted `harness/AGENTS.md` survived
// a folder move that way — the checker reported clean while the paths were dead.
test("a slashed .md path cited inside a code span is checked", () => {
  const result = run(repoWith({ ".claude/a.md": "see `gone/nope.md` for detail\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing cited path `gone\/nope\.md`/u);
});

test("a cited path resolves either repo-root-relative or dir-relative", () => {
  const dir = repoWith({ ".claude/sub/a.md": "root `top/real.md`, dir `sub/real.md`\n", "top/real.md": "hi\n", ".claude/sub/sub/real.md": "hi\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a bare filename with no slash is not treated as a path claim", () => {
  const dir = repoWith({ ".claude/a.md": "write it in `CHANGELOG.md` when done\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a placeholder path in a code span is not flagged", () => {
  const dir = repoWith({ ".claude/a.md": "put it in `docs/design/<feature>.md`\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a cited path inside a fenced block is not flagged", () => {
  const dir = repoWith({ ".claude/a.md": "```\ncat gone/nope.md\n```\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// Locks the SCOPE, not just the detection. Widening the cited-path check past the
// agent-instruction files re-introduces a false-positive class: a CHANGELOG entry
// names a file as it stood at the time, and a corpus fixture names files that exist
// only inside the fixture. Both are correct; flagging them teaches agents to ignore
// this gate's output.
test("a dead cited path outside the agent-instruction files is not flagged", () => {
  const dir = repoWith({
    "CHANGELOG.md": "moved out of `docs/design/old-home.md` in this release\n",
    "apps/cli/sample-corpus/EXPECTED.md": "the corpus contains `notes/finances.md`\n",
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});
