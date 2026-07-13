// node --test coverage for the check-api-boot pure helpers (no server boot).

import assert from "node:assert/strict";
import test from "node:test";

import { bootFailureHint, findFreePort } from "./check-api-boot.mjs";

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

test("findFreePort yields a usable numeric port", async () => {
  const port = await findFreePort();
  assert.equal(typeof port, "number");
  assert.ok(port > 0 && port < 65_536);
});
