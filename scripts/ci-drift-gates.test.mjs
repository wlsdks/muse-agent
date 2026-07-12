import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// The deterministic drift guards (identity single-source seam + secret-
// persistence guard coverage) run in `pnpm self-eval` on every autonomous-loop
// fire, but a HUMAN pull request never runs self-eval — only GitHub CI. So the
// CI workflow MUST invoke them, or a hardcoded-identity string / an unguarded
// write tool could merge through a human PR unnoticed. This pins that wiring:
// remove either CI step and this test goes red.

const ciYaml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "ci.yml"),
  "utf8"
);

test("CI runs the identity prompt-seam drift guard", () => {
  assert.match(ciYaml, /run:\s*pnpm check:prompt-seam\b/u, "ci.yml must run `pnpm check:prompt-seam`");
});

test("CI runs the secret-guard-coverage drift guard", () => {
  assert.match(ciYaml, /run:\s*pnpm check:secret-guard-coverage\b/u, "ci.yml must run `pnpm check:secret-guard-coverage`");
});
