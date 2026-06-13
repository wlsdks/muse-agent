// Reflection-schedule guard (frontier F11): self-reflection reliably helps
// ONLY when an external verifier backs it — on open-ended tasks a bare
// "think again" pass repeats the original failure 85.36% of the time
// (arXiv 2510.18254). Every retry/reflection surface in Muse must therefore
// be paired with a deterministic or judge-backed verifier IN THE SAME FILE.
// This registry IS the policy's enumeration: add a new retry surface here
// (with its verifier marker) or the addition is a policy violation.
// Run: node --test scripts/reflection-guard.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

const REFLECTION_SURFACES = [
  {
    file: "packages/agent-core/src/attributed-repair.ts",
    retryMarker: "rewrite",
    surface: "--repair constructive rewrite",
    verifierMarker: "verify("
  },
  {
    file: "packages/agent-core/src/knowledge-recall.ts",
    retryMarker: "reverify(",
    surface: "weak-band reverify escalation",
    verifierMarker: "fail-closed"
  },
  {
    file: "apps/cli/src/commands-ask.ts",
    retryMarker: "drawBestGroundedRedraft(",
    surface: "--best-of resample",
    verifierMarker: "confirm"
  },
  {
    file: "apps/cli/src/commands-skills.ts",
    retryMarker: "attempts",
    surface: "skill-merge self-consistency retry",
    verifierMarker: "lost"
  },
  {
    file: "apps/cli/src/chat-repl.ts",
    retryMarker: "const actNow",
    surface: "false-done action re-run",
    verifierMarker: "actionToolRan("
  },
  {
    file: "packages/agent-core/src/plan-execute-loop.ts",
    retryMarker: "PLAN_REPAIR_MAX_ROUNDS",
    surface: "plan validation repair",
    verifierMarker: "validatePlan("
  }
];

test("every retry/reflection surface is paired with its external verifier (no bare 'think again' loops)", () => {
  for (const entry of REFLECTION_SURFACES) {
    const source = readFileSync(join(ROOT, entry.file), "utf8");
    assert.ok(
      source.includes(entry.retryMarker),
      `${entry.surface}: retry marker '${entry.retryMarker}' missing from ${entry.file} — update the registry if the surface moved`
    );
    assert.ok(
      source.includes(entry.verifierMarker),
      `${entry.surface}: verifier marker '${entry.verifierMarker}' missing from ${entry.file} — a retry surface lost its external verifier (arXiv 2510.18254: unverified reflection repeats the mistake 85% of the time)`
    );
  }
});
