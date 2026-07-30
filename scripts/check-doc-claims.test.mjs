import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(here, "check-doc-claims.mjs");

const MANIFEST = { name: "root", scripts: { lint: "eslint .", "eval:tools": "node x.mjs" } };

function repoWith(files, manifest = MANIFEST) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-docclaims-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8" });

test("a documented script that exists passes", () => {
  const dir = repoWith({ "CLAUDE.md": "run `pnpm eval:tools` after touching a schema\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a documented script that does not exist fails", () => {
  const result = run(repoWith({ "CLAUDE.md": "run `pnpm eval:tools:nl` for the NL set\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no such script `pnpm eval:tools:nl`/u);
});

test("flags are skipped so the script name is still found", () => {
  const result = run(repoWith({ "CLAUDE.md": "`pnpm -s run gone` and `pnpm --silent lint`\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no such script `pnpm gone`/u);
  assert.doesNotMatch(result.stdout, /lint/u);
});

test("a fenced block is scanned", () => {
  const result = run(repoWith({ "docs/a.md": "```bash\npnpm nope\n```\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /docs\/a\.md:2: no such script `pnpm nope`/u);
});

// Twelve false positives against one real find is what a raw-line scan produced: docs
// legitimately discuss "the pnpm workspace" and "pnpm 10" as prose. Only a command the
// doc FORMATTED as a command is a claim that it can be run.
test("prose mentioning pnpm is not a command claim", () => {
  const dir = repoWith({ "CONTRIBUTING.md": "Requirements: Node 22 + pnpm 10\nUses the pnpm workspace protocol.\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a placeholder is documentation, not a claim", () => {
  const dir = repoWith({ "CLAUDE.md": "`pnpm --filter @muse/<name> build`\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("pnpm's own verbs are not scripts", () => {
  const dir = repoWith({ "CLAUDE.md": "`pnpm install --frozen-lockfile`\n" });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});

test("a --filter target is resolved against that workspace's own scripts", () => {
  const files = {
    "packages/web/package.json": `${JSON.stringify({ name: "@muse/web", scripts: { "test:browser": "vitest" } })}\n`,
    "CLAUDE.md": "`pnpm --filter @muse/web test:browser` then `pnpm --filter @muse/web gone`\n",
  };
  const result = run(repoWith(files));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no such script `pnpm gone`/u);
  assert.doesNotMatch(result.stdout, /test:browser/u);
});

test("an unknown workspace is reported", () => {
  const result = run(repoWith({ "CLAUDE.md": "`pnpm --filter @muse/ghost build`\n" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unknown workspace @muse\/ghost/u);
});

// Scope lock: a historical record naming a command as it stood is correct, not drift.
// Widening past normative docs re-introduces that false-positive class.
test("a dead command in a historical record is not flagged", () => {
  const dir = repoWith({
    "CHANGELOG.md": "removed `pnpm eval:retired` in this release\n",
    "internal/goals/backlog.md": "- [done] ran `pnpm eval:retired` that fire\n",
  });
  assert.equal(run(dir).status, 0, run(dir).stdout);
});
