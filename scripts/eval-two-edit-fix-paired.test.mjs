import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assessPairedExecution,
  assertCurrentPairedBaseline,
  createCombinedChildRunRecord,
  resolveLocalOllamaBase,
  stagePairedAgentArtifacts
} from "./lib/paired-agent-candidate.mjs";
import {
  createSingleAgentBaselineArtifact,
  createSingleAgentBaselineContract
} from "./lib/multi-agent-baseline.mjs";

const HEAD = "a".repeat(40);
const NOW = "2026-07-29T00:00:00.000Z";

function contract() {
  return createSingleAgentBaselineContract({
    budget: { maxEffects: 6, repeatCount: 1, wallclockMs: 120_000 },
    datasetSeed: "two-edit-fix-v1",
    fixture: { definition: { fixed: true }, id: "two-edit-fix-v1" },
    rubric: { criteria: ["terminal"], id: "terminal-v1" },
    taskFamily: "two-edit-fix"
  });
}

function run({ passed, status = "completed" }) {
  return {
    costState: status === "completed" ? "recorded" : "unknown",
    costUsd: status === "completed" ? "0" : null,
    effectCount: 1,
    latencyMs: 10,
    quality: { passed },
    runStatus: status,
    tokenUsage: status === "completed" ? {} : null,
    toolCount: 2,
    toolsUsed: ["file_edit"],
    uncertainEffectCount: 0
  };
}

function baseline() {
  return createSingleAgentBaselineArtifact({
    contract: contract(),
    generatedAt: NOW,
    model: "ollama/gemma4:12b",
    provider: "ollama",
    runs: [run({ passed: false })],
    source: { head: HEAD, upstream: HEAD, worktree: "clean" }
  });
}

test("paired live runner fails closed when local Ollama is unavailable", async () => {
  const child = execFile(
    process.execPath,
    ["scripts/eval-two-edit-fix-paired.mjs"],
    {
      cwd: process.cwd(),
      env: { ...process.env, OLLAMA_BASE_URL: "http://127.0.0.1:1" },
      timeout: 10_000
    }
  );
  const [code, stdout] = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve([exitCode, output]));
  });

  assert.equal(code, 4);
  assert.match(stdout, /^UNAVAILABLE: Ollama unreachable/u);
});

test("paired runner is local-only, bounded, scoped, and report-only", async () => {
  const source = await readFile(
    new URL("./eval-two-edit-fix-paired.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /http:\/\/127\.0\.0\.1:11434/u);
  assert.match(source, /createDelegationHandoffLease/u);
  assert.match(source, /writablePaths: \["src\/alpha\.mjs"\]/u);
  assert.match(source, /writablePaths: \["src\/beta\.mjs"\]/u);
  assert.match(source, /mode: "parallel"/u);
  assert.doesNotMatch(source, /https:\/\//u);
});

test("loopback resolver rejects remote, credentials, TLS, and malformed URLs before fetch", () => {
  assert.equal(resolveLocalOllamaBase("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(resolveLocalOllamaBase("http://localhost:11434"), "http://localhost:11434");
  assert.equal(resolveLocalOllamaBase("http://[::1]:11434"), "http://[::1]:11434");
  for (const value of [
    "https://localhost:11434",
    "http://example.com:11434",
    "http://user:secret@127.0.0.1:11434",
    "not-a-url"
  ]) {
    assert.throws(() => resolveLocalOllamaBase(value), /loopback|invalid/u);
  }
});

test("baseline preflight rejects stale, dirty, mismatched, and over-budget evidence", () => {
  const current = baseline();
  const fixtureHash = current.contract.fixture.sha256;
  assert.equal(assertCurrentPairedBaseline({
    baseline: current,
    fixtureHash,
    head: HEAD,
    upstream: HEAD,
    worktree: "clean"
  }).wallclockMs, 120_000);
  for (const input of [
    { baseline: current, fixtureHash, head: "b".repeat(40), upstream: HEAD, worktree: "clean" },
    { baseline: current, fixtureHash, head: HEAD, upstream: HEAD, worktree: "dirty" },
    { baseline: current, fixtureHash: "f".repeat(64), head: HEAD, upstream: HEAD, worktree: "clean" },
    {
      baseline: {
        ...current,
        contract: { ...current.contract, budget: { ...current.contract.budget, wallclockMs: 120_001 } }
      },
      fixtureHash,
      head: HEAD,
      upstream: HEAD,
      worktree: "clean"
    }
  ]) {
    assert.throws(() => assertCurrentPairedBaseline(input), /current clean|fixture|120-second/u);
  }
});

test("execution requires exact completed worker steps, child histories, and zero blocked calls", () => {
  const records = [
    { costUsd: "0", id: "child-alpha", status: "completed", tokenUsage: { inputTokens: 1 } },
    { costUsd: "0", id: "child-beta", status: "completed", tokenUsage: { inputTokens: 2 } }
  ];
  const result = {
    results: [
      { status: "completed", workerId: "alpha" },
      { status: "completed", workerId: "beta" }
    ]
  };
  const green = assessPairedExecution({
    blockedToolCalls: [],
    childRecords: records,
    expectedChildRunIds: ["child-alpha", "child-beta"],
    requestedWorkerIds: ["alpha", "beta"],
    result,
    uncertainToolCalls: []
  });
  assert.equal(green.ok, true);
  assert.deepEqual(createCombinedChildRunRecord(records, green), {
    costUsd: "0.000000",
    status: "completed",
    tokenUsage: { inputTokens: 3 }
  });

  for (const changed of [
    { result: { results: [{ status: "failed", workerId: "alpha" }, result.results[1]] } },
    { childRecords: [records[0], { ...records[1], status: "cancelled" }] },
    { blockedToolCalls: [{ name: "file_edit", risk: "write", status: "blocked" }] },
    { uncertainToolCalls: [{ name: "file_edit", risk: "write", status: "failed" }] },
    { expectedChildRunIds: ["other-alpha", "other-beta"] },
    { expectedChildRunIds: ["child-alpha", "child-beta", "ghost"] },
    { result: { results: [result.results[1], result.results[0]] } }
  ]) {
    const decision = assessPairedExecution({
      blockedToolCalls: [],
      childRecords: records,
      expectedChildRunIds: ["child-alpha", "child-beta"],
      requestedWorkerIds: ["alpha", "beta"],
      result,
      uncertainToolCalls: [],
      ...changed
    });
    assert.equal(decision.ok, false);
    assert.equal(createCombinedChildRunRecord(changed.childRecords ?? records, decision), undefined);
  }
  assert.equal(
    createCombinedChildRunRecord(
      [{ ...records[0], costUsd: "" }, records[1]],
      green
    ),
    undefined
  );
});

test("both artifacts validate before either write and comparison remains report-only", () => {
  const control = baseline();
  const staged = stagePairedAgentArtifacts({
    baseline: control,
    candidateInput: {
      contract: control.contract,
      generatedAt: NOW,
      model: control.model,
      provider: control.provider,
      runs: [run({ passed: true })],
      source: { head: HEAD }
    },
    comparisonGeneratedAt: NOW,
    comparisonSource: { head: HEAD }
  });
  assert.equal(staged.comparison.decision.outcome, "promote-multi-agent");
  assert.equal(staged.comparison.decision.promotionApplied, false);

  assert.throws(
    () => stagePairedAgentArtifacts({
      baseline: control,
      candidateInput: {
        contract: { ...control.contract, comparisonInputHash: "0".repeat(64) },
        generatedAt: NOW,
        model: control.model,
        provider: control.provider,
        runs: [run({ passed: true })],
        source: { head: HEAD }
      },
      comparisonGeneratedAt: NOW,
      comparisonSource: { head: HEAD }
    }),
    /input hash is invalid/u
  );
});
