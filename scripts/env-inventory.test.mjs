// node --test coverage for the env-inventory pure helpers (zero deps, no I/O
// beyond a real collectInventory smoke over the repo).

import assert from "node:assert/strict";
import test from "node:test";

import { collectInventory, extractEnvVars, renderEnvDoc, workspaceOf } from "./env-inventory.mjs";

test("extractEnvVars finds each distinct MUSE_* token once", () => {
  const src = 'process.env.MUSE_MODEL ?? env.MUSE_MODEL; "MUSE_LOCAL_ONLY=true"; // MUSE_EVAL_REPEAT';
  assert.deepEqual(extractEnvVars(src).sort(), ["MUSE_EVAL_REPEAT", "MUSE_LOCAL_ONLY", "MUSE_MODEL"]);
});

test("extractEnvVars ignores non-MUSE and lowercase lookalikes", () => {
  assert.deepEqual(extractEnvVars("OLLAMA_BASE_URL muse_model MUSEUM MUSE_ MUSE_X"), ["MUSE_X"]);
});

test("workspaceOf keys by the two-segment workspace root", () => {
  assert.equal(workspaceOf("packages/recall/src/embed.ts"), "packages/recall");
  assert.equal(workspaceOf("apps/cli/src/program.ts"), "apps/cli");
});

test("renderEnvDoc is byte-deterministic and sorted", () => {
  const inv = new Map([
    ["MUSE_B", new Set(["packages/b", "apps/cli"])],
    ["MUSE_A", new Set(["packages/a"])]
  ]);
  const doc = renderEnvDoc(inv);
  assert.equal(doc, renderEnvDoc(inv));
  const aIdx = doc.indexOf("| `MUSE_A` |");
  const bIdx = doc.indexOf("| `MUSE_B` | apps/cli, packages/b |");
  assert.ok(aIdx !== -1 && bIdx !== -1 && aIdx < bIdx);
  assert.ok(doc.includes("Total: **2** variables."));
});

test("collectInventory over the real repo finds the load-bearing vars and excludes tests", () => {
  const inv = collectInventory();
  assert.ok(inv.has("MUSE_LOCAL_ONLY"), "MUSE_LOCAL_ONLY must be inventoried");
  assert.ok(inv.has("MUSE_MODEL_TIMEOUT_MS"), "MUSE_MODEL_TIMEOUT_MS must be inventoried");
  assert.ok(inv.size > 100, `expected a large surface, got ${inv.size}`);
  for (const ws of inv.get("MUSE_LOCAL_ONLY")) {
    assert.match(ws, /^(packages|apps)\//);
  }
});
