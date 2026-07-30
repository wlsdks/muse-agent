import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(here, "check-agent-registry.mjs");

function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-agentreg-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const agent = (name) => `---\nname: ${name}\ndescription: judges a build\n---\n\nbody\n`;
const run = (dir) => spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });

test("a matching filename and frontmatter name passes", () => {
  const dir = repoWith({ ".claude/agents/independent-evaluator.md": agent("independent-evaluator") });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// The host resolves subagent_type against the frontmatter name, not the filename, so a
// mismatch either fails the invocation or silently selects something else.
test("frontmatter name that does not match the filename fails", () => {
  const result = run(repoWith({ ".claude/agents/independent-evaluator.md": agent("harness-evaluator") }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /does not match the filename/u);
});

test("a missing frontmatter name fails", () => {
  const result = run(repoWith({ ".claude/agents/thing.md": "---\ndescription: x\n---\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no frontmatter name/u);
});

test("a doc naming an agent that exists passes", () => {
  const dir = repoWith({
    ".claude/agents/independent-evaluator.md": agent("independent-evaluator"),
    ".claude/harness/dev-loop.md": "use the independent-evaluator subagent for the verdict\n",
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// Renaming the evaluator touched five referencing files; a sixth would have rotted silently.
test("a doc naming an agent that does not exist fails", () => {
  const result = run(repoWith({
    ".claude/agents/independent-evaluator.md": agent("independent-evaluator"),
    ".claude/harness/dev-loop.md": "use the `harness-evaluator` subagent for the verdict\n",
  }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /names a `harness-evaluator` subagent with no such agent file/u);
});

test("a host-provided agent needs no file in this repo", () => {
  const dir = repoWith({ "CLAUDE.md": "delegate to the general-purpose subagent when it is wide\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// Scope lock: an agent file's own body describes itself in the first person and a historical
// record names agents that were deleted. Neither is a live pointer.
test("the agent files themselves and non-normative docs are not scanned for names", () => {
  const dir = repoWith({
    ".claude/agents/independent-evaluator.md": `${agent("independent-evaluator")}\nnot the harness-worker subagent\n`,
    "internal/goals/backlog.md": "- [done] ran the harness-curator subagent that fire\n",
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a repo with no agents directory is clean, not an error", () => {
  const dir = repoWith({ "CLAUDE.md": "no agents here\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});
