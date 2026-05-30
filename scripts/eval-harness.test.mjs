import assert from "node:assert/strict";
import { test } from "node:test";

import {
  combineScorers,
  llmJudge,
  runEvalSuite,
  runShadowTrial,
  shadowTrialScorer,
  toolScorers,
} from "./eval-harness.mjs";

// The harness is the foundation every agent-eval battery runs on (eval:tools,
// eval:judge, eval:adversarial, eval:plan-quality, eval:shadow-trial). A bug in
// its deterministic scoring / verdict parsing / gate math silently corrupts
// every battery's PASS/FAIL, so its pure logic is pinned here with no Ollama —
// the LLM-judge / shadow-trial paths use a contract-faithful fake provider that
// returns canned text, exercising the REAL parsing, not a stubbed scorer.

const call = (name, args) => ({ arguments: args, name });
const fakeProvider = (output) => ({ async generate() { return { output }; } });
const silent = { err: () => {}, log: () => {} };

test("toolScorers.noTool — passes on zero calls, fails on any call", () => {
  assert.equal(toolScorers.noTool()([]).ok, true);
  const bad = toolScorers.noTool()([call("get_weather", {})]);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /eager call: get_weather/);
});

test("toolScorers.selected — fails with no call, matches the FIRST call, ignores later calls", () => {
  assert.equal(toolScorers.selected("x")([]).ok, false);
  assert.match(toolScorers.selected("x")([]).detail, /no tool selected/);
  assert.equal(toolScorers.selected("get_weather")([call("get_weather", { city: "seoul" })]).ok, true);
  // a wrong first call fails even if a later call would match
  const wrong = toolScorers.selected("get_weather")([call("web_search", {}), call("get_weather", {})]);
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /picked web_search, wanted get_weather/);
});

test("toolScorers.argMatches — regex over the first call's stringified args; empty args is {}", () => {
  assert.equal(toolScorers.argMatches(/seoul/i)([call("t", { city: "Seoul" })]).ok, true);
  assert.equal(toolScorers.argMatches(/tokyo/i)([call("t", { city: "Seoul" })]).ok, false);
  // no calls → args default to {} → only a regex matching "{}" passes
  assert.equal(toolScorers.argMatches(/seoul/i)([]).ok, false);
  assert.equal(toolScorers.argMatches(/\{\}/)([]).ok, true);
});

test("toolScorers.argsPresent — every key present + non-empty; whitespace-only string is missing", () => {
  assert.equal(toolScorers.argsPresent(["a", "b"])([call("t", { a: 1, b: "x" })]).ok, true);
  // a numeric 0 / false present value counts as present (only undefined/null/blank-string miss)
  assert.equal(toolScorers.argsPresent(["a"])([call("t", { a: 0 })]).ok, true);
  const miss = toolScorers.argsPresent(["a", "b", "c"])([call("t", { a: 1, b: "", c: "   " })]);
  assert.equal(miss.ok, false);
  assert.match(miss.detail, /missing\/empty required arg\(s\) \[b, c\]/);
  assert.equal(toolScorers.argsPresent(["a"])([call("t", { a: null })]).ok, false);
});

test("combineScorers — ANDs scorers, first failure's detail wins, else the last detail", async () => {
  const ok1 = () => ({ detail: "first", ok: true });
  const ok2 = () => ({ detail: "second", ok: true });
  const bad = () => ({ detail: "boom", ok: false });
  assert.deepEqual(await combineScorers(ok1, ok2)(), { detail: "second", ok: true });
  assert.deepEqual(await combineScorers(ok1, bad, ok2)(), { detail: "boom", ok: false });
  // empty combiner is vacuously true with empty detail
  assert.deepEqual(await combineScorers()(), { detail: "", ok: true });
});

test("llmJudge — parses a strict PASS/FAIL first word and matches expectVerdict", async () => {
  const judge = llmJudge(fakeProvider("PASS\nlooks good"), "m");
  assert.equal((await judge("out", { expectVerdict: "PASS", rubric: "r" })).ok, true);
  // default expectVerdict is PASS
  assert.equal((await judge("out", { rubric: "r" })).ok, true);
  // a FAIL verdict against an expected PASS fails
  const failJudge = llmJudge(fakeProvider("FAIL\nnope"), "m");
  assert.equal((await failJudge("out", { rubric: "r" })).ok, false);
  // an expected-FAIL case passes when the judge says FAIL (must-refuse style)
  assert.equal((await failJudge("out", { expectVerdict: "FAIL", rubric: "r" })).ok, true);
});

test("llmJudge — case-insensitive, leading-whitespace tolerant, garbage → '?' (never silently PASS)", async () => {
  assert.equal((await llmJudge(fakeProvider("  pass — fine"), "m")("o", { rubric: "r" })).ok, true);
  const garbage = await llmJudge(fakeProvider("I think maybe yes?"), "m")("o", { rubric: "r" });
  assert.equal(garbage.ok, false);
  assert.match(garbage.detail, /judge \?, expected PASS/);
});

test("runShadowTrial — parses the three-line VERDICT/REASON/RISK report", async () => {
  const r = await runShadowTrial(fakeProvider("VERDICT: PROMOTE\nREASON: clearly better\nRISK: none"), "m", {});
  assert.deepEqual(r, { reason: "clearly better", risk: "none", verdict: "PROMOTE" });
  const hold = await runShadowTrial(fakeProvider("VERDICT: HOLD\nREASON: unconfirmed claim\nRISK: fabrication"), "m", {});
  assert.equal(hold.verdict, "HOLD");
  assert.equal(hold.risk, "fabrication");
  // no recognizable verdict → "?" (report-only never invents PROMOTE)
  assert.equal((await runShadowTrial(fakeProvider("hmm not sure"), "m", {})).verdict, "?");
});

test("shadowTrialScorer — passes only when the parsed verdict matches expectVerdict", async () => {
  const promote = shadowTrialScorer(fakeProvider("VERDICT: PROMOTE\nREASON: better\nRISK: none"), "m");
  assert.equal((await promote(null, { expectVerdict: "PROMOTE" })).ok, true);
  assert.equal((await promote(null, { expectVerdict: "HOLD" })).ok, false);
});

test("runEvalSuite — gate is rate >= threshold; the report tallies passed/total", async () => {
  const scenarios = [{ cases: [{ want: true }, { want: true }, { want: false }], label: "s" }];
  const solve = async (c) => c.want;
  const score = (observed) => ({ detail: "", ok: observed === true });
  const r = await runEvalSuite({ name: "t", scenarios, solve, score, threshold: 0.6, ...silent });
  assert.equal(r.total, 3);
  assert.equal(r.passed, 2);
  assert.equal(r.gate, true); // 2/3 = 0.67 >= 0.6
  const strict = await runEvalSuite({ name: "t", scenarios, solve, score, threshold: 0.9, ...silent });
  assert.equal(strict.gate, false); // 0.67 < 0.9
});

test("runEvalSuite — repeat is STRICT: a case that flakes on any run fails the whole case", async () => {
  let n = 0;
  const scenarios = [{ cases: [{}], label: "s" }];
  const solve = async () => { n += 1; return n; };
  // passes on run 1, fails on run 2 → strict all-runs means the case fails
  const score = (observed) => ({ detail: `run ${observed}`, ok: observed === 1 });
  const r = await runEvalSuite({ name: "t", repeat: 3, scenarios, solve, score, ...silent });
  assert.equal(r.passed, 0);
  assert.equal(r.total, 1);
});

test("runEvalSuite — a throwing solver is caught and scored as a failed case, not a crash", async () => {
  const scenarios = [{ cases: [{}], label: "s" }];
  const solve = async () => { throw new Error("provider down"); };
  const score = () => ({ detail: "", ok: true });
  const r = await runEvalSuite({ name: "t", scenarios, solve, score, ...silent });
  assert.equal(r.passed, 0);
  assert.equal(r.gate, false);
});

test("runEvalSuite — a skipped scenario is excluded from the tally; all-skipped → rate 0, gate false", async () => {
  const scenarios = [
    { cases: [{ want: true }], label: "real", skip: undefined },
    { cases: [{ want: true }, { want: true }], label: "skipme", skip: "no model" },
  ];
  const r = await runEvalSuite({ name: "t", scenarios, solve: async (c) => c.want, score: (o) => ({ detail: "", ok: o === true }), ...silent });
  assert.equal(r.total, 1); // the 2 skipped cases are not counted
  assert.equal(r.passed, 1);
  const allSkipped = await runEvalSuite({ name: "t", scenarios: [{ cases: [{}], label: "x", skip: "down" }], solve: async () => true, score: () => ({ detail: "", ok: true }), ...silent });
  assert.equal(allSkipped.total, 0);
  assert.equal(allSkipped.rate, 0);
  assert.equal(allSkipped.gate, false); // total 0 never gates true
});
