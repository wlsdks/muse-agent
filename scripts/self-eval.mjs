#!/usr/bin/env node
// Self-eval scoreboard — the loop's measurable fitness signal.
//
// The autonomous capability loop ships features and verifies each one,
// but it had no AGGREGATED, persisted signal of whether the system as a
// whole is improving or regressing over time. This runs the deterministic
// gates, records a timestamped entry to docs/self-eval-scoreboard.json,
// and FAILS CLOSED (exit 1) when a gate that previously passed now fails
// or a tracked count drops — so "regression-first" becomes mechanical, not
// a thing the loop has to remember. Zero deps; the script IS the check.
//
//   node scripts/self-eval.mjs           # quick: lint + capabilities drift + counts
//   node scripts/self-eval.mjs --full    # also runs the whole test suite
//
// Pure helpers (detectRegressions / summarize / parsers) are exported and
// unit-tested via `node --test scripts/self-eval.test.mjs`.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCOREBOARD = join(ROOT, "docs/self-eval-scoreboard.json");
const SOURCE_ROOTS = ["packages", "apps"];
const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Pure helpers (no IO) — exported for node:test.
// ---------------------------------------------------------------------------

/** Count distinct `*.test.ts(x)` basenames in a flat file-name list. */
export function countTestFileNames(names) {
  return new Set(names.filter((n) => /\.test\.tsx?$/u.test(n))).size;
}

/**
 * Count CAPABILITIES.md lines that cite a real proof (a `*.test.ts(x)` file
 * or a `scripts/*.mjs`). A dropping count means the loop's success metric
 * shrank — a regression worth surfacing.
 */
export function countVerifiedCapabilityLines(capabilitiesText) {
  let n = 0;
  for (const line of capabilitiesText.split("\n")) {
    if (/\b[\w.-]+\.test\.tsx?\b/u.test(line) || /\bscripts\/[\w.-]+\.mjs\b/u.test(line)) {
      n += 1;
    }
  }
  return n;
}

/**
 * Count the live batteries registered in the fabrication=0 release gate
 * (scripts/eval-self-improving.mjs's BATTERIES array). CLAUDE.md's invariant —
 * "grounded-surface count never drops" — was enforced only by discipline; the
 * only git hook is the immutable-core commit-msg guard, so a commit that quietly
 * drops a surface from the release battery passed a green `pnpm check`. Counting
 * the registry deterministically (no Ollama) turns the invariant into a numeric
 * ratchet: detectRegressions fails self-eval the moment the count falls.
 */
export function countGroundedSurfaces(selfImprovingSource) {
  const matches = selfImprovingSource.match(/file:\s*"apps\/(?:cli|api)\/scripts\/verify-[\w-]+\.mjs"/gu);
  return matches ? matches.length : 0;
}

/**
 * Count the labelled CASES in the grounding eval corpus. The surface ratchet counts
 * battery FILES, so adding (or silently DROPPING) a case inside an existing corpus
 * leaves it blind — the most common write-back is a new golden case, not a new file.
 * Counting `kind:` entries in the corpus turns a dropped case into a numeric
 * regression too. Deterministic (no Ollama); pairs with countGroundedSurfaces.
 */
export function countGroundedCases(corpusSource) {
  const matches = corpusSource.match(/\bkind:\s*"/gu);
  return matches ? matches.length : 0;
}

/**
 * Case-count ratchet for the OTHER golden sets (eval:tools / adversarial /
 * plan-quality): their cases all carry a `prompt:` literal, so a silently
 * dropped case becomes a numeric regression exactly like groundedCases.
 */
export function countPromptCases(batterySource) {
  const matches = batterySource.match(/\bprompt:\s*"/gu);
  return matches ? matches.length : 0;
}

/**
 * Count the egress guards that enforce Muse's SECOND moat — local-by-construction
 * ("cloud egress refused in code", MUSE_LOCAL_ONLY on by default). Unlike the
 * grounding moat, this one had NO scoreboard ratchet: a commit that silently
 * drops a provider id from the gated CLOUD_PROVIDER_IDS set (so it escapes
 * classifyProviderLocality) OR deletes a fail-close `throw new LocalOnlyViolationError`
 * enforcement site passed a green `pnpm check`. Counting both stable markers in
 * the combined policy + router source turns "cloud egress refused in code" from a
 * tested property into a numeric invariant — detectRegressions fails self-eval the
 * moment the guard count falls. Deterministic (no Ollama); pairs with
 * countGroundedSurfaces. Rivals whose default is cloud cannot ship such a gate —
 * it would block their own product.
 *
 * Four stable markers, one per egress surface: gated cloud provider ids
 * (the model router), `throw new LocalOnlyViolationError` (router enforcement),
 * the voice registry forcing the OpenAI key to undefined under
 * MUSE_LOCAL_ONLY (so mic audio can never reach a cloud STT/TTS API), and the
 * privacy-tiered request router's `if (localOnly)` fail-close (so a personal
 * or unclassified request can never be routed to MUSE_CLOUD_MODEL while
 * local-only is set — see packages/policy/src/privacy-routing.ts).
 */
export function countEgressGuards(combinedSource) {
  const gatedIds = combinedSource.match(/CLOUD_PROVIDER_IDS[^=]*=\s*new Set\(\[([^\]]*)\]/u);
  const ids = gatedIds ? (gatedIds[1].match(/"[^"]+"/gu) ?? []).length : 0;
  const throwSites = (combinedSource.match(/throw new LocalOnlyViolationError\(/gu) ?? []).length;
  const voiceGuards = (combinedSource.match(/parseBoolean\(env\.MUSE_LOCAL_ONLY,\s*true\)\s*\?\s*undefined/gu) ?? []).length;
  const privacyRoutingGuards = (combinedSource.match(/if\s*\(localOnly\)\s*\{/gu) ?? []).length;
  return ids + throwSites + voiceGuards + privacyRoutingGuards;
}

/**
 * Count the differentiation PROOF batteries — the deterministic `scripts/eval-*.mjs`
 * scripts that prove a structural edge vs hermes/openclaw (memory-poisoning,
 * receipt-drift, action-log-tamper, policy-symmetry). Each carries the header
 * marker "Differentiation proof battery"; counting them turns "the edge proofs
 * never silently vanish" into a numeric ratchet — delete a battery and
 * detectRegressions fails self-eval, exactly like countGroundedSurfaces guards the
 * grounding batteries. `scriptSources` is the array of `scripts/eval-*.mjs` contents.
 */
export function countDifferentiationBatteries(scriptSources) {
  return scriptSources.filter((s) => s.includes("Differentiation proof battery")).length;
}

/**
 * Gate names allowed to go present→missing without counting as a regression.
 * `verifiedCapabilities` is intentionally conditional (self-eval only emits
 * it when docs/goals/CAPABILITIES.md exists — the ledger was deliberately
 * removed in f4c195df so the agent discovers work itself); without this
 * allowlist its absence would read as a permanent regression on every run.
 * Exported so a test can prove the allowlist itself is load-bearing.
 */
export const ERASURE_ALLOWLIST = new Set(["verifiedCapabilities"]);

/**
 * Regressions between the previous scoreboard entry and the current one: a
 * boolean gate that went pass→fail, a numeric gate whose value dropped, or a
 * gate present in `prev` but absent from `curr` entirely (present→missing —
 * deleting the gate/store is otherwise a silent way to launder a bad score,
 * since a dropped gate was never visited by the loop above). No previous
 * entry ⇒ nothing to regress against.
 */
export function detectRegressions(prev, curr) {
  const out = [];
  if (!prev || !prev.gates) {
    return out;
  }
  for (const [name, c] of Object.entries(curr.gates)) {
    const p = prev.gates[name];
    if (!p) {
      continue;
    }
    if (p.status === "pass" && c.status === "fail") {
      out.push(`${name}: pass→fail`);
    }
    if (typeof p.value === "number" && typeof c.value === "number" && c.value < p.value) {
      out.push(`${name}: ${String(p.value)}→${String(c.value)}`);
    }
  }
  for (const name of Object.keys(prev.gates)) {
    if (!(name in curr.gates) && !ERASURE_ALLOWLIST.has(name)) {
      out.push(`${name}: present→missing (erased)`);
    }
  }
  return out;
}

/**
 * The comparison baseline for the next run: the last entry, but every numeric
 * gate raised to its historical HIGH-WATER mark. `main()` persists every entry
 * (the audit trail), so without this a run that regressed and was written would
 * BECOME the baseline — the drop laundered to green on the next run, and a loop
 * that crashed mid-fire or one ignored red run would bury the regression
 * permanently. A ratchet must not fall below its peak, so the peak is what the
 * next run is measured against. Boolean status and the gate key set still come
 * from the last entry (pass→fail and present→missing are correctly per-previous,
 * not per-peak). Empty history ⇒ nothing to compare against.
 */
export function highWaterBaseline(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return undefined;
  }
  const last = history[history.length - 1];
  const gates = { ...last.gates };
  for (const entry of history) {
    for (const [name, g] of Object.entries(entry.gates ?? {})) {
      const cur = gates[name];
      if (cur && typeof cur.value === "number" && typeof g.value === "number") {
        gates[name] = { ...cur, value: Math.max(cur.value, g.value) };
      }
    }
  }
  return { ...last, gates };
}

/** One-line human summary of an entry plus any regressions. */
export function summarize(entry, regressions) {
  const parts = Object.entries(entry.gates).map(([name, g]) =>
    g.value !== undefined ? `${name}=${String(g.value)}` : `${name}:${g.status}`);
  const head = regressions.length > 0 ? `REGRESSION (${String(regressions.length)})` : "ok";
  return `[self-eval ${head}] ${parts.join("  ")}${regressions.length > 0 ? ` — ${regressions.join("; ")}` : ""}`;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function gateExit(command) {
  try {
    execSync(command, { cwd: ROOT, stdio: "ignore" });
    return { status: "pass" };
  } catch {
    return { status: "fail" };
  }
}

function walkTestNames(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTestNames(full, acc);
    } else {
      acc.push(entry.name);
    }
  }
  return acc;
}

function countTestFiles() {
  const names = [];
  for (const root of SOURCE_ROOTS) {
    const p = join(ROOT, root);
    if (existsSync(p)) {
      walkTestNames(p, names);
    }
  }
  return countTestFileNames(names);
}

function readScoreboard() {
  if (!existsSync(SCOREBOARD)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(SCOREBOARD, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function main() {
  const full = process.argv.includes("--full");
  const gates = {};

  gates.lint = gateExit("pnpm -s lint");
  gates.capabilities = gateExit("pnpm -s check:capabilities");
  gates.promptSeam = gateExit("pnpm -s check:prompt-seam");
  gates.envInventory = gateExit("pnpm -s check:env");
  gates.ledgerFormat = gateExit("node scripts/check-ledger-format.mjs");
  gates.commentMarkers = gateExit("pnpm -s lint:comments");
  gates.toolchain = gateExit("pnpm -s check:toolchain");
  // Gate runnability: a stale install/dist kills the API server at import
  // time and every live smoke gate silently rots with it — surface that as a
  // scoreboard regression, not a surprise at the next manual smoke run.
  gates.apiBoot = gateExit("pnpm -s check:api-boot");
  gates.testFiles = { status: "pass", value: countTestFiles() };
  // The prescribed CAPABILITIES.md ledger was intentionally removed (f4c195df —
  // "so the agent discovers work itself"). Only emit this count WHEN the file
  // exists: an absent ledger otherwise reads as a permanent 35→0 regression on
  // EVERY run, poisoning the loop's fitness signal. The count auto-resumes if a
  // ledger is ever restored; the pure helper + its test stay valid meanwhile.
  const capabilitiesPath = join(ROOT, "docs/goals/CAPABILITIES.md");
  if (existsSync(capabilitiesPath)) {
    gates.verifiedCapabilities = { status: "pass", value: countVerifiedCapabilityLines(readFileSync(capabilitiesPath, "utf8")) };
  }
  const releaseGatePath = join(ROOT, "scripts/eval-self-improving.mjs");
  const releaseGateSrc = existsSync(releaseGatePath) ? readFileSync(releaseGatePath, "utf8") : "";
  gates.groundedSurfaces = { status: "pass", value: countGroundedSurfaces(releaseGateSrc) };
  const corpusPath = join(ROOT, "apps/cli/src/grounding-eval-corpus.ts");
  const corpusSrc = existsSync(corpusPath) ? readFileSync(corpusPath, "utf8") : "";
  gates.groundedCases = { status: "pass", value: countGroundedCases(corpusSrc) };
  const egressSources = [
    "packages/model/src/local-only-policy.ts",
    "packages/autoconfigure/src/autoconfigure-model-provider.ts",
    "packages/autoconfigure/src/registry-builders/voice.ts",
    "packages/autoconfigure/src/context-engineering-builders.ts",
    // createOllamaEmbedder's LocalOnlyViolationError guard moved here from
    // context-engineering-builders.ts (codebase-quality cohere) — keep its
    // throw-site counted so the egressGuards ratchet follows the guard.
    "packages/autoconfigure/src/embedder-base.ts",
    "packages/policy/src/privacy-routing.ts"
  ]
    .map((rel) => join(ROOT, rel))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  gates.egressGuards = { status: "pass", value: countEgressGuards(egressSources) };
  const scriptsDir = join(ROOT, "scripts");
  const evalScriptSources = existsSync(scriptsDir)
    ? readdirSync(scriptsDir)
        .filter((n) => /^eval-.*\.mjs$/u.test(n))
        .map((n) => readFileSync(join(scriptsDir, n), "utf8"))
    : [];
  gates.differentiationBatteries = { status: "pass", value: countDifferentiationBatteries(evalScriptSources) };
  for (const [gateName, batteryFile] of [
    ["toolCases", "scripts/eval-tool-selection.mjs"],
    ["adversarialCases", "scripts/eval-adversarial.mjs"],
    ["planCases", "scripts/eval-plan-quality.mjs"]
  ]) {
    const batteryPath = join(ROOT, batteryFile);
    const batterySrc = existsSync(batteryPath) ? readFileSync(batteryPath, "utf8") : "";
    gates[gateName] = { status: "pass", value: countPromptCases(batterySrc) };
  }
  if (full) {
    gates.tests = gateExit("pnpm -s -r test");
  }

  const entry = { at: new Date().toISOString(), gates };
  const history = readScoreboard();
  const prev = highWaterBaseline(history);
  const regressions = detectRegressions(prev, entry);

  const next = [...history, entry].slice(-MAX_HISTORY);
  writeFileSync(SCOREBOARD, `${JSON.stringify(next, null, 2)}\n`);

  console.log(summarize(entry, regressions));

  const anyFail = Object.values(gates).some((g) => g.status === "fail");
  process.exitCode = anyFail || regressions.length > 0 ? 1 : 0;
}

// Only run main() when executed directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
