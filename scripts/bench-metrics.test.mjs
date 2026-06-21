import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nsToMs,
  tokensPerSecond,
  sampleFromOllamaTimings,
  percentile,
  mean,
  summarizeSamples,
  detectRegression
} from "./lib/bench-metrics.mjs";

test("nsToMs converts nanoseconds and floors junk to 0", () => {
  assert.equal(nsToMs(1_000_000), 1);
  assert.equal(nsToMs(2_500_000), 2.5);
  assert.equal(nsToMs(0), 0);
  assert.equal(nsToMs(-5), 0);
  assert.equal(nsToMs(undefined), 0);
});

test("tokensPerSecond computes tokens / seconds", () => {
  assert.equal(tokensPerSecond(100, 2000), 50); // 100 tok / 2s
  assert.equal(tokensPerSecond(30, 1000), 30);
  // guards: zero/negative duration or tokens → 0, never NaN/Infinity
  assert.equal(tokensPerSecond(100, 0), 0);
  assert.equal(tokensPerSecond(0, 1000), 0);
  assert.equal(tokensPerSecond(100, -1), 0);
});

test("sampleFromOllamaTimings derives ttft + throughput from raw ns fields", () => {
  const sample = sampleFromOllamaTimings({
    load_duration: 500_000_000, // 500ms
    prompt_eval_duration: 1_000_000_000, // 1000ms
    prompt_eval_count: 200, // → 200 tok/s prompt-eval
    eval_duration: 2_000_000_000, // 2000ms
    eval_count: 60, // → 30 tok/s gen
    total_duration: 3_500_000_000 // 3500ms
  });
  assert.equal(sample.ttftMs, 1500); // load + prompt_eval
  assert.equal(sample.totalMs, 3500);
  assert.equal(sample.promptTps, 200);
  assert.equal(sample.genTps, 30);
  assert.equal(sample.genTokens, 60);
});

test("percentile interpolates and handles edges", () => {
  const v = [10, 20, 30, 40, 50];
  assert.equal(percentile(v, 50), 30);
  assert.equal(percentile(v, 0), 10);
  assert.equal(percentile(v, 100), 50);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([], 50), 0);
  // p95 of 1..100 interpolates between rank floor/ceil
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.ok(Math.abs(percentile(hundred, 95) - 95.05) < 1e-9);
});

test("mean ignores non-finite values", () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(mean([10, NaN, 20]), 15);
  assert.equal(mean([]), 0);
});

test("summarizeSamples reduces samples to latency + throughput stats", () => {
  const samples = [
    { ttftMs: 1000, totalMs: 3000, genTps: 30, promptTps: 200 },
    { ttftMs: 1200, totalMs: 3400, genTps: 28, promptTps: 180 },
    { ttftMs: 1100, totalMs: 3200, genTps: 32, promptTps: 220 }
  ];
  const s = summarizeSamples(samples);
  assert.equal(s.runs, 3);
  assert.equal(s.ttftMs.p50, 1100);
  assert.equal(s.ttftMs.min, 1000);
  assert.equal(s.ttftMs.max, 1200);
  assert.equal(s.genTps.p50, 30);
  assert.equal(s.genTps.mean, 30); // (30+28+32)/3
  assert.equal(s.promptTps.min, 180);
});

test("summarizeSamples throws on empty input (a 0-run summary is a caller bug)", () => {
  assert.throws(() => summarizeSamples([]), /at least one sample/);
  assert.throws(() => summarizeSamples(undefined), /at least one sample/);
});

test("detectRegression flags a throughput drop beyond tolerance", () => {
  const baseline = {
    genTps: { p50: 30 },
    promptTps: { p50: 200 },
    ttftMs: { p95: 1500 }
  };
  const current = {
    genTps: { p50: 24 }, // 20% drop > 15% tol
    promptTps: { p50: 200 },
    ttftMs: { p95: 1500 }
  };
  const verdict = detectRegression(baseline, current, 15);
  assert.equal(verdict.regressed, true);
  assert.equal(verdict.reasons.length, 1);
  assert.match(verdict.reasons[0], /gen throughput p50 dropped 20\.0%/);
});

test("detectRegression passes a within-tolerance drift", () => {
  const baseline = { genTps: { p50: 30 }, promptTps: { p50: 200 }, ttftMs: { p95: 1500 } };
  const current = {
    genTps: { p50: 28 }, // ~6.7% drop < 15%
    promptTps: { p50: 195 }, // 2.5% drop
    ttftMs: { p95: 1600 } // ~6.7% rise < 15%
  };
  const verdict = detectRegression(baseline, current, 15);
  assert.equal(verdict.regressed, false);
  assert.deepEqual(verdict.reasons, []);
});

test("detectRegression flags a latency rise beyond tolerance", () => {
  const baseline = { genTps: { p50: 30 }, promptTps: { p50: 200 }, ttftMs: { p95: 1000 } };
  const current = {
    genTps: { p50: 30 },
    promptTps: { p50: 200 },
    ttftMs: { p95: 1300 } // 30% rise > 15% tol
  };
  const verdict = detectRegression(baseline, current, 15);
  assert.equal(verdict.regressed, true);
  assert.match(verdict.reasons[0], /TTFT p95 rose 30\.0%/);
});
