import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(here, "check-harness-agents.mjs");
const ROLES = ["harness-worker", "harness-evaluator", "harness-planner", "harness-curator"];

function repo({ liveBody, templateBody }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-harness-agents-"));
  for (const role of ROLES) {
    const live = path.join(dir, ".claude/agents", `${role}.md`);
    const template = path.join(dir, "harness/templates/claude-code/agents", `${role}.md`);
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.mkdirSync(path.dirname(template), { recursive: true });
    fs.writeFileSync(live, `---\nname: ${role}\ntools: Read\n---\n${liveBody}`);
    fs.writeFileSync(template, `---\nname: ${role}\ntools: Read, Write\n---\n${templateBody}`);
  }
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });

test("identical bodies pass", () => {
  const dir = repo({ liveBody: "Rules:\n- do the thing\n", templateBody: "Rules:\n- do the thing\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("the Muse-vs-neutral identity line is the one allowed difference", () => {
  const dir = repo({
    liveBody: "You are the WORKER subagent of the Muse agent harness.\n- do the thing\n",
    templateBody: "You are the WORKER subagent of the agent harness.\n- do the thing\n"
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("differing frontmatter is allowed — tools differ by design", () => {
  const dir = repo({ liveBody: "same body\n", templateBody: "same body\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

// The regression this gate exists for: a rule landed in one copy only, and the live
// evaluator silently lost the instruction that makes maker != judge mean anything.
test("a rule present in only one copy fails", () => {
  const dir = repo({
    liveBody: "Rules:\n- go criterion by criterion\n",
    templateBody: "Rules:\n- go criterion by criterion\n- do not read the maker's build conversation\n"
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /diverged beyond the Muse\/neutral wording/u);
});

test("a missing live definition fails", () => {
  const dir = repo({ liveBody: "same\n", templateBody: "same\n" });
  fs.rmSync(path.join(dir, ".claude/agents/harness-curator.md"));
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is missing/u);
});

test("a missing export template fails", () => {
  const dir = repo({ liveBody: "same\n", templateBody: "same\n" });
  fs.rmSync(path.join(dir, "harness/templates/claude-code/agents/harness-planner.md"));
  assert.equal(run(dir).status, 1);
});
