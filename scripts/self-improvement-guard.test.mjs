/**
 * The guard that keeps the self-improvement registry HONEST.
 *
 * A learning surface can rot in four different ways, and every one of them
 * happened this week while the suite was green:
 *
 *   1. the entry point is renamed or deleted        -> the surface silently stops existing
 *   2. its gate default is flipped to `false`       -> it stops firing for every user
 *   3. its live proof is deleted or unregistered    -> nothing would notice (1) or (2)
 *   4. a NEW surface ships with no proof at all     -> it can be born dead (this is
 *                                                      how credit-assignment shipped
 *                                                      firing on 3 of 13 corrections
 *                                                      and decay on 0 of 13)
 *
 * Each test below closes one of those. Run: `node --test scripts/self-improvement-guard.test.mjs`
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SELF_IMPROVEMENT_SURFACES } from "./self-improvement-registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

test("every surface's entry point exists and is exported", () => {
  for (const s of SELF_IMPROVEMENT_SURFACES) {
    assert.ok(existsSync(join(ROOT, s.entry.file)), `${s.surface}: entry file missing — ${s.entry.file}`);
    const src = read(s.entry.file);
    const exported = new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${s.entry.symbol}\\b`, "u").test(src);
    assert.ok(exported, `${s.surface}: ${s.entry.file} does not export ${s.entry.symbol} — the surface was renamed or removed`);
  }
});

test("every surface names a PRODUCTION caller (an inert surface is not a feature)", () => {
  for (const s of SELF_IMPROVEMENT_SURFACES) {
    assert.ok(
      typeof s.firesFrom === "string" && s.firesFrom.trim().length > 0,
      `${s.surface}: no production caller named. If you cannot say who calls it, it does not learn anything.`
    );
  }
});

test("each gate's DEFAULT in the code matches what the registry claims", () => {
  // The registry is what a maintainer reads. A default flipped in the code and not
  // here is exactly the silent-death case: `MUSE_SELFLEARN_ENABLED` sat at `false`
  // for months while the docs said the loop was real.
  for (const s of SELF_IMPROVEMENT_SURFACES) {
    if (!s.gate) continue;
    const { env, default: claimed } = s.gate;
    const sources = [
      "apps/cli/src/daemon-selflearn-ticks.ts",
      "apps/cli/src/chat-end-session-pipeline.ts",
      "apps/cli/src/chat-distill-corrections.ts",
      "packages/autoconfigure/src/context-engineering-builders.ts",
      "packages/autoconfigure/src/runtime-assembly.ts",
      "packages/autoconfigure/src/decay-contradicted.ts"
    ].filter((f) => existsSync(join(ROOT, f)));

    let found;
    for (const file of sources) {
      const src = read(file);
      const m = new RegExp(`parseBoolean\\(\\s*(?:process\\.)?e(?:nv)?\\.${env}\\s*,\\s*(true|false)\\s*\\)`, "u").exec(src);
      if (m) {
        found = m[1] === "true";
        break;
      }
    }
    // A gate the guard cannot locate is not a pass — it means the flag moved and
    // nobody would notice its default changing.
    assert.notEqual(found, undefined, `${s.surface}: could not find the default for ${env} — did the gate move?`);
    assert.equal(
      found,
      claimed,
      `${s.surface}: ${env} defaults to ${String(found)} in the code but the registry claims ${String(claimed)}. ` +
        "Either the default was flipped silently, or the registry is stale — both are the bug this guard exists for."
    );
  }
});

test("every surface has a LIVE proof, and that proof runs in the release gate", () => {
  // A proof that exists but is not wired into eval:self-improving never runs, and a
  // surface whose proof never runs is indistinguishable from a dead one.
  const releaseGate = read("scripts/eval-self-improving.mjs");
  for (const s of SELF_IMPROVEMENT_SURFACES) {
    assert.ok(existsSync(join(ROOT, s.liveProof)), `${s.surface}: live proof missing — ${s.liveProof}`);
    const registered = releaseGate.includes(s.liveProof) || releaseGate.includes(s.liveProof.replace(/^apps\/cli\//u, "../apps/cli/"));
    assert.ok(
      registered,
      `${s.surface}: ${s.liveProof} is not registered in scripts/eval-self-improving.mjs — it would never run, so nothing would catch this surface going dead`
    );
  }
});

test("a NEW learning surface cannot ship unregistered", () => {
  // The reverse check. These symbols are the shape of a learning surface — a
  // function that writes to the playbook, the skill bank, or the user model. If one
  // exists in the codebase and is not in the registry, it has no liveness proof and
  // can be born dead, which is exactly how credit-assignment shipped.
  const MUST_BE_REGISTERED = [
    "distillSessionCorrections",
    "distillQueuedCorrections",
    "decayContradictedStrategies",
    "selectCreditTargetLlm",
    "applyPlaybook",
    "reviewSkillsFromTurns",
    "mergeSkillsIntoUmbrella",
    "synthesizePatternSuggestion",
    "createUserMemoryAutoExtractHook"
  ];
  const registered = new Set(SELF_IMPROVEMENT_SURFACES.map((s) => s.entry.symbol));
  const unregistered = MUST_BE_REGISTERED.filter((symbol) => !registered.has(symbol));
  assert.deepEqual(
    unregistered,
    ["distillQueuedCorrections"],
    "a learning entry point is missing from the registry (or the known-exception list is stale). " +
      "Add it to scripts/self-improvement-registry.mjs together with a live proof — a surface with no proof can be born dead."
  );
});
