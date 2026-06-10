// Deterministic unit tests for the self-eval pure helpers.
// Run: node --test scripts/self-eval.test.mjs   (zero deps, no Ollama)

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countGroundedCases,
  countGroundedSurfaces,
  countTestFileNames,
  countVerifiedCapabilityLines,
  detectRegressions,
  summarize
} from "./self-eval.mjs";

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
    "];",
    '// a stray reference with no `file:` prefix must NOT count: apps/cli/scripts/verify-helper.mjs',
    'const other = "scripts/eval-agent.mjs";'
  ].join("\n");
  assert.equal(countGroundedSurfaces(src), 3);
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

test("summarize flags regressions and renders gate values", () => {
  const entry = { at: "now", gates: { lint: { status: "pass" }, testFiles: { status: "pass", value: 42 } } };
  assert.match(summarize(entry, []), /\[self-eval ok\].*lint:pass.*testFiles=42/u);
  assert.match(summarize(entry, ["lint: pass→fail"]), /REGRESSION \(1\).*lint: pass→fail/u);
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
