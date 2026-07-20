// node --test coverage for the check-api-boot pure helpers (no server boot).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bootFailureHint } from "./check-api-boot.mjs";

test("bootFailureHint maps missing-package output to a pnpm install repair", () => {
  const hint = bootFailureHint(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@muse/prompts' imported from x.ts"
  );
  assert.match(hint, /pnpm install/u);
});

test("bootFailureHint maps missing-export output to a rebuild repair", () => {
  const hint = bootFailureHint(
    "SyntaxError: The requested module '@muse/multi-agent' does not provide an export named 'OrchestrationCancelledError'"
  );
  assert.match(hint, /build/u);
});

test("bootFailureHint stays silent on unknown output", () => {
  assert.equal(bootFailureHint("some unrelated crash"), undefined);
});

test("boot check starts the API in-process with the tsx loader", () => {
  const source = readFileSync(new URL("./check-api-boot.mjs", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|\.kill\s*\(/u);
  assert.match(source, /startInProcessApi/u);
  assert.equal(manifest.scripts["check:api-boot"], "node --import tsx scripts/check-api-boot.mjs");
});
