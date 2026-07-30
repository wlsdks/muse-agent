// Deterministic unit tests for the self-eval pure helpers.
// Run: node --test scripts/self-eval.test.mjs   (zero deps, no Ollama)

import assert from "node:assert/strict";
import { test } from "node:test";

import { ERASURE_ALLOWLIST, countDifferentiationBatteries, countEgressGuards, countGroundedCases, countGroundedSurfaces, countTestFileNames, countVerifiedCapabilityLines, detectRegressions, highWaterBaseline, parseRatchetAllowances, summarize } from "./self-eval.mjs";

test("countTestFileNames counts distinct *.test.ts(x), ignoring non-tests", () => {
  assert.equal(countTestFileNames(["a.test.ts", "b.test.tsx", "a.test.ts", "c.ts", "d.md"]), 2);
  assert.equal(countTestFileNames([]), 0);
});

test("countVerifiedCapabilityLines counts only lines citing a test file or script", () => {
  const text = [
    "[Reach] foo — surface — a.test.ts — P1",
    "[Anticipation] bar — surface — scripts/smoke-broad-http.mjs — P2",
    "## a heading with no proof",
    "[Autonomy] baz — surface — (no citation yet)"
  ].join("\n");
  assert.equal(countVerifiedCapabilityLines(text), 2);
});

test("countGroundedSurfaces counts registered release-gate batteries, ignoring other file refs", () => {
  const src = [
    "const BATTERIES = [",
    '  { axis: "★ WEDGE: cited recall", file: "apps/cli/scripts/verify-cited-recall.mjs", name: "cited-recall" },',
    '  { axis: "★ WEDGE: rubric re-verify", file: "apps/cli/scripts/verify-rubric-reverify.mjs", name: "rubric-reverify" },',
    '  { axis: "★ VISION", file: "apps/cli/scripts/verify-vision-grounding.mjs", name: "vision-grounding" },',
    '  { axis: "★ WEDGE: SSE ask stream", file: "apps/api/scripts/verify-sse-ask-stream.mjs", name: "sse-ask-stream" },',
    "];",
    '// a stray reference with no `file:` prefix must NOT count: apps/cli/scripts/verify-helper.mjs',
    'const other = "scripts/eval-agent.mjs";'
  ].join("\n");
  assert.equal(countGroundedSurfaces(src), 4);
  assert.equal(countGroundedSurfaces(""), 0);
});

test("countGroundedSurfaces: a dropped surface is a numeric regression via detectRegressions", () => {
  const prev = { gates: { groundedSurfaces: { status: "pass", value: 27 } } };
  const curr = { gates: { groundedSurfaces: { status: "pass", value: 26 } } };
  assert.deepEqual(detectRegressions(prev, curr), ["groundedSurfaces: 27→26"]);
});

test("countGroundedCases counts kind: entries in the grounding corpus, so a dropped case regresses", () => {
  const corpus = [
    "export const GROUNDING_EVAL_CORPUS = {",
    '  notes: [{ source: "a.md", text: "kind: not a case — inside a string" }],',
    "  cases: [",
    '    { kind: "answerable", query: "q1", answer: "a [from a.md]" },',
    '    { kind: "refuse", query: "q2" },',
    '    { kind: "drift", query: "q3", answer: "x" }',
    "  ]",
    "};"
  ].join("\n");
  assert.equal(countGroundedCases(corpus), 3); // the in-string "kind:" (no quote after) is not counted
  assert.equal(countGroundedCases(""), 0);
  // a dropped case is a numeric regression
  const prev = { gates: { groundedCases: { status: "pass", value: 29 } } };
  const curr = { gates: { groundedCases: { status: "pass", value: 28 } } };
  assert.deepEqual(detectRegressions(prev, curr), ["groundedCases: 29→28"]);
});

test("detectRegressions: pass→fail and numeric drops are regressions", () => {
  const prev = { gates: { lint: { status: "pass" }, testFiles: { status: "pass", value: 100 } } };
  const curr = { gates: { lint: { status: "fail" }, testFiles: { status: "pass", value: 97 } } };
  const r = detectRegressions(prev, curr);
  assert.ok(r.some((x) => x.startsWith("lint:")));
  assert.ok(r.some((x) => x.includes("100→97")));
  assert.equal(r.length, 2);
});

test("detectRegressions: improvements and first-run are NOT regressions", () => {
  const prev = { gates: { testFiles: { status: "pass", value: 100 }, lint: { status: "fail" } } };
  const curr = { gates: { testFiles: { status: "pass", value: 120 }, lint: { status: "pass" } } };
  assert.deepEqual(detectRegressions(prev, curr), []); // count up + fail→pass = no regression
  assert.deepEqual(detectRegressions(undefined, curr), []); // no baseline
});

test("detectRegressions ignores gates absent from the previous entry", () => {
  const prev = { gates: { lint: { status: "pass" } } };
  const curr = { gates: { lint: { status: "pass" }, tests: { status: "fail" } } };
  assert.deepEqual(detectRegressions(prev, curr), []); // `tests` is new, not a regression
});

test("detectRegressions: a gate present in prev and erased from curr is a regression", () => {
  const prev = { gates: { lint: { status: "pass" }, groundedSurfaces: { status: "pass", value: 27 } } };
  const curr = { gates: { lint: { status: "pass" } } };
  assert.deepEqual(detectRegressions(prev, curr), ["groundedSurfaces: present→missing (erased)"]);
});

test("detectRegressions: an ALLOWLISTED gate erased from curr is NOT a regression", () => {
  const prev = {
    gates: { lint: { status: "pass" }, verifiedCapabilities: { status: "pass", value: 35 } }
  };
  const curr = { gates: { lint: { status: "pass" } } };
  assert.deepEqual(detectRegressions(prev, curr), []);
});

test("the allowlist entry is load-bearing: removing it from ERASURE_ALLOWLIST un-suppresses the regression", () => {
  const prev = {
    gates: { lint: { status: "pass" }, verifiedCapabilities: { status: "pass", value: 35 } }
  };
  const curr = { gates: { lint: { status: "pass" } } };
  assert.ok(ERASURE_ALLOWLIST.has("verifiedCapabilities"));
  ERASURE_ALLOWLIST.delete("verifiedCapabilities");
  try {
    assert.deepEqual(detectRegressions(prev, curr), ["verifiedCapabilities: present→missing (erased)"]);
  } finally {
    ERASURE_ALLOWLIST.add("verifiedCapabilities");
  }
});

test("summarize flags regressions and renders gate values", () => {
  const entry = { at: "now", gates: { lint: { status: "pass" }, testFiles: { status: "pass", value: 42 } } };
  assert.match(summarize(entry, []), /\[self-eval ok\].*lint:pass.*testFiles=42/u);
  assert.match(summarize(entry, ["lint: pass→fail"]), /REGRESSION \(1\).*lint: pass→fail/u);
});

test("countEgressGuards counts gated cloud ids + LocalOnlyViolationError throw sites (local-by-construction ratchet)", () => {
  const combined = [
    '/** Provider ids that ALWAYS reach a third-party cloud LLM API. */',
    'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);',
    "export function classifyProviderLocality(providerId, baseUrl) {",
    "  if (CLOUD_PROVIDER_IDS.has(providerId)) { return \"cloud\"; }",
    "}",
    "// enforcement: the model router refuses to start against cloud under local-only",
    "      throw new LocalOnlyViolationError(providerId, effectiveBaseUrl);",
  ].join("\n");
  // 4 gated cloud ids + 1 throw site = 5 egress guards
  assert.equal(countEgressGuards(combined), 5);
  assert.equal(countEgressGuards(""), 0);
});

test("countEgressGuards: dropping a gated cloud id OR an enforcement throw is a numeric regression", () => {
  const full = 'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);\nthrow new LocalOnlyViolationError(a, b);';
  // a provider id silently removed from the gated set → escapes classifyProviderLocality
  const droppedId = 'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini"]);\nthrow new LocalOnlyViolationError(a, b);';
  // the enforcement throw deleted → the router stops refusing cloud egress
  const droppedThrow = 'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);';
  assert.equal(countEgressGuards(full), 5);
  assert.equal(countEgressGuards(droppedId), 4);
  assert.equal(countEgressGuards(droppedThrow), 4);
  const prev = { gates: { egressGuards: { status: "pass", value: countEgressGuards(full) } } };
  const curr = { gates: { egressGuards: { status: "pass", value: countEgressGuards(droppedId) } } };
  assert.deepEqual(detectRegressions(prev, curr), ["egressGuards: 5→4"]);
});

test("countEgressGuards also counts the voice local-only cloud-key-ignore guard", () => {
  // the autoconfigure voice registry forces the OpenAI key to undefined under
  // MUSE_LOCAL_ONLY, killing every cloud STT/TTS branch — an egress guard.
  const voiceGuard = "  const openAiKey = parseBoolean(env.MUSE_LOCAL_ONLY, true)\n    ? undefined\n    : env.OPENAI_API_KEY;";
  assert.equal(countEgressGuards(voiceGuard), 1);
  // combined with policy + router: 4 cloud ids + 1 throw + 1 voice guard = 6
  const combined = [
    'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);',
    "throw new LocalOnlyViolationError(providerId, baseUrl);",
    voiceGuard
  ].join("\n");
  assert.equal(countEgressGuards(combined), 6);
  // deleting the voice guard is a numeric regression
  const withoutVoice = 'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);\nthrow new LocalOnlyViolationError(a, b);';
  const prev = { gates: { egressGuards: { status: "pass", value: countEgressGuards(combined) } } };
  const curr = { gates: { egressGuards: { status: "pass", value: countEgressGuards(withoutVoice) } } };
  assert.deepEqual(detectRegressions(prev, curr), ["egressGuards: 6→5"]);
});

test("countEgressGuards also counts the privacy-routing router's local-only fail-close", () => {
  // packages/policy/src/privacy-routing.ts checks `if (localOnly)` before it will
  // ever consider routing to MUSE_CLOUD_MODEL — an egress guard distinct from the
  // model-router throw site.
  const routerGuard = "  const localOnly = parseEnvBoolean(args.env.MUSE_LOCAL_ONLY, false);\n  if (localOnly) {\n    return local;\n  }";
  assert.equal(countEgressGuards(routerGuard), 1);
  // combined with policy + router + voice: 4 cloud ids + 1 throw + 1 voice + 1 privacy-routing = 7
  const combined = [
    'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);',
    "throw new LocalOnlyViolationError(providerId, baseUrl);",
    "  const openAiKey = parseBoolean(env.MUSE_LOCAL_ONLY, true)\n    ? undefined\n    : env.OPENAI_API_KEY;",
    routerGuard
  ].join("\n");
  assert.equal(countEgressGuards(combined), 7);
  // deleting the privacy-routing guard is a numeric regression
  const withoutPrivacyRouting = [
    'const CLOUD_PROVIDER_IDS = new Set(["openai", "anthropic", "gemini", "openrouter"]);',
    "throw new LocalOnlyViolationError(providerId, baseUrl);",
    "  const openAiKey = parseBoolean(env.MUSE_LOCAL_ONLY, true)\n    ? undefined\n    : env.OPENAI_API_KEY;"
  ].join("\n");
  const prev = { gates: { egressGuards: { status: "pass", value: countEgressGuards(combined) } } };
  const curr = { gates: { egressGuards: { status: "pass", value: countEgressGuards(withoutPrivacyRouting) } } };
  assert.deepEqual(detectRegressions(prev, curr), ["egressGuards: 7→6"]);
});

test("countDifferentiationBatteries counts the marker-bearing proof batteries (a deleted one regresses)", () => {
  const sources = [
    "// Differentiation proof battery — local-by-construction\nimport x;",
    "// Differentiation proof battery — receipt drift\nimport y;",
    "// just an ordinary eval script, no marker",
    "const s = 'Differentiation proof battery';" // marker only inside a string literal still counts (file-level grep) — acceptable
  ];
  assert.equal(countDifferentiationBatteries(sources), 3);
  assert.equal(countDifferentiationBatteries([]), 0);
  // a deleted battery is a numeric regression via detectRegressions
  const prev = { gates: { differentiationBatteries: { status: "pass", value: 4 } } };
  const curr = { gates: { differentiationBatteries: { status: "pass", value: 3 } } };
  assert.deepEqual(detectRegressions(prev, curr), ["differentiationBatteries: 4→3"]);
});

test("countPromptCases counts prompt-bearing battery cases (ratchet for every golden set)", async () => {
  const { countPromptCases } = await import("./self-eval.mjs");
  const src = `
  const CASES = [
    { prompt: "What's the weather?", expectTool: "get_weather" },
    { prompt: "서울 날씨", expectNoTool: true },
  ];
  const BANK = [{ prompt: "지금 몇 시야?", tool: "time_now" }];
  // not a case: prompt mentioned in prose
  `;
  assert.equal(countPromptCases(src), 3);
  assert.equal(countPromptCases(""), 0);
});

test("highWaterBaseline: a persisted regression cannot launder the ratchet", () => {
  // run 1 wrote a drop (100→90) which persisted; the next run at 90 must STILL
  // regress against the peak of 100, not read green because 90 became the baseline.
  const history = [{ gates: { testFiles: { status: "pass", value: 100 } } }, { gates: { testFiles: { status: "pass", value: 90 } } }];
  const baseline = highWaterBaseline(history);
  assert.equal(baseline.gates.testFiles.value, 100);
  const curr = { gates: { testFiles: { status: "pass", value: 90 } } };
  assert.deepEqual(detectRegressions(baseline, curr), ["testFiles: 100→90"]);
});

test("highWaterBaseline: recovering to the peak clears the regression", () => {
  const history = [{ gates: { testFiles: { status: "pass", value: 100 } } }, { gates: { testFiles: { status: "pass", value: 90 } } }];
  const recovered = { gates: { testFiles: { status: "pass", value: 100 } } };
  assert.deepEqual(detectRegressions(highWaterBaseline(history), recovered), []);
});

test("highWaterBaseline: boolean status and gate keys come from the LAST entry, not the peak", () => {
  // present→missing must be per-previous: a gate in an OLD entry but not the last
  // one is not resurrected into the baseline (so its long-ago removal isn't re-flagged).
  const history = [{ gates: { a: { status: "pass" }, gone: { status: "pass", value: 5 } } }, { gates: { a: { status: "pass" } } }];
  const baseline = highWaterBaseline(history);
  assert.equal("gone" in baseline.gates, false);
});

test("highWaterBaseline: empty history has no baseline", () => {
  assert.equal(highWaterBaseline([]), undefined);
});

// Subtraction is first-class work here, but every numeric ratchets against a high-water
// mark — so deleting a dead test used to make ORIENT permanently red, with the only escapes
// being to undo it, pad the count back, or `rm` the untracked scoreboard. The declaration
// makes the deliberate case sayable where a reviewer can check it against the diff.
test("parseRatchetAllowances reads declarations from a commit body", () => {
  const found = parseRatchetAllowances("chore: prune\n\nbody\n\n[ratchet: testFiles -3]\n");
  assert.equal(found.get("testFiles"), 3);
  assert.equal(parseRatchetAllowances("no declaration here").size, 0);
  const two = parseRatchetAllowances("[ratchet: testFiles -2] and [ratchet: toolCases -10]");
  assert.equal(two.get("testFiles"), 2);
  assert.equal(two.get("toolCases"), 10);
});

test("a declared drop within the allowance is not a regression", () => {
  const prev = { gates: { testFiles: { status: "pass", value: 100 } } };
  const curr = { gates: { testFiles: { status: "pass", value: 97 } } };
  assert.deepEqual(detectRegressions(prev, curr), ["testFiles: 100→97"]);
  assert.deepEqual(detectRegressions(prev, curr, new Map([["testFiles", 3]])), []);
});

test("a drop BIGGER than declared is still a regression, and says so", () => {
  const prev = { gates: { testFiles: { status: "pass", value: 100 } } };
  const curr = { gates: { testFiles: { status: "pass", value: 90 } } };
  const [only] = detectRegressions(prev, curr, new Map([["testFiles", 3]]));
  assert.match(only, /declared -3, actual -10/u);
});

test("an allowance for one gate never excuses another", () => {
  const prev = { gates: { testFiles: { status: "pass", value: 10 }, toolCases: { status: "pass", value: 10 } } };
  const curr = { gates: { testFiles: { status: "pass", value: 9 }, toolCases: { status: "pass", value: 9 } } };
  assert.deepEqual(detectRegressions(prev, curr, new Map([["testFiles", 1]])), ["toolCases: 10→9"]);
});

test("an allowance never excuses a pass→fail gate", () => {
  const prev = { gates: { lint: { status: "pass" } } };
  const curr = { gates: { lint: { status: "fail" } } };
  assert.deepEqual(detectRegressions(prev, curr, new Map([["lint", 99]])), ["lint: pass→fail"]);
});

// The declaration alone cured nothing: it is read from the LATEST commit, so once HEAD
// advanced past it the max-over-history resurrected the old peak and the drop was reported
// forever. An accepted subtraction has to move the floor.
test("a declared drop restarts the gate's high-water mark", () => {
  const declared = [
    { gates: { t: { status: "pass", value: 100 } } },
    { gates: { t: { status: "pass", value: 97 } }, ratchetReset: { t: 97 } },
    { gates: { t: { status: "pass", value: 97 } } },
  ];
  assert.equal(highWaterBaseline(declared).gates.t.value, 97);
});

test("an UNDECLARED drop leaves the high-water mark intact", () => {
  const undeclared = [
    { gates: { t: { status: "pass", value: 100 } } },
    { gates: { t: { status: "pass", value: 97 } } },
  ];
  assert.equal(highWaterBaseline(undeclared).gates.t.value, 100);
});

test("a reset for one gate does not lower another gate's peak", () => {
  const history = [
    { gates: { a: { status: "pass", value: 10 }, b: { status: "pass", value: 10 } } },
    { gates: { a: { status: "pass", value: 4 }, b: { status: "pass", value: 4 } }, ratchetReset: { a: 4 } },
  ];
  const peaks = highWaterBaseline(history).gates;
  assert.equal(peaks.a.value, 4);
  assert.equal(peaks.b.value, 10);
});

test("growth after a reset ratchets again from the new floor", () => {
  const history = [
    { gates: { t: { status: "pass", value: 100 } } },
    { gates: { t: { status: "pass", value: 50 } }, ratchetReset: { t: 50 } },
    { gates: { t: { status: "pass", value: 60 } } },
  ];
  assert.equal(highWaterBaseline(history).gates.t.value, 60);
});
