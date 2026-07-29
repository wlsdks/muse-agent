import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEffectBudgetGate,
  createMultiAgentCandidateArtifact,
  createObservedBaselineTool,
  createPairedAgentComparison,
  createSingleAgentBaselineArtifact,
  createSingleAgentBaselineContract,
  summarizeSingleAgentRun,
  writeMultiAgentEvaluationArtifact,
  writeSingleAgentBaselineArtifact
} from "./lib/multi-agent-baseline.mjs";

function contract(overrides = {}) {
  return createSingleAgentBaselineContract({
    budget: { maxEffects: 6, repeatCount: 1, wallclockMs: 120_000 },
    datasetSeed: "two-edit-fix-v1",
    fixture: { definition: { alpha: 1, beta: 10, noise: "stable" }, id: "two-edit-fix-v1" },
    rubric: {
      criteria: ["alpha() === 2", "beta() === 20", "noise byte-identical"],
      id: "two-edit-terminal-v1"
    },
    taskFamily: "two-edit-fix",
    ...overrides
  });
}

function arm({
  arm: armName,
  contract: armContract = contract(),
  costState = "recorded",
  costUsd = "0",
  passedRuns = 1,
  uncertainEffectCount = 0
}) {
  const create = armName === "multi-agent"
    ? createMultiAgentCandidateArtifact
    : createSingleAgentBaselineArtifact;
  return create({
    contract: armContract,
    generatedAt: "2026-07-29T00:00:00.000Z",
    model: "gemma4:12b",
    provider: "ollama",
    runs: [{
      costState,
      costUsd: costState === "recorded" ? costUsd : null,
      effectCount: 1,
      latencyMs: 10,
      quality: { passed: passedRuns === 1 },
      runStatus: costState === "recorded" ? "completed" : "failed",
      tokenUsage: costState === "recorded" ? {} : null,
      toolCount: 2,
      toolsUsed: ["file_edit"],
      uncertainEffectCount
    }],
    source: { head: "a".repeat(40) }
  });
}

test("freezes comparison inputs and exposes unsupported model seed honestly", () => {
  const first = contract();
  const second = contract();
  const changed = contract({ datasetSeed: "two-edit-fix-v2" });

  assert.equal(first.comparisonInputHash, second.comparisonInputHash);
  assert.notEqual(first.comparisonInputHash, changed.comparisonInputHash);
  assert.deepEqual(first.modelSeed, { control: "unsupported", value: null });
  assert.match(first.fixture.sha256, /^[a-f0-9]{64}$/u);
  assert.match(first.rubric.sha256, /^[a-f0-9]{64}$/u);
});

test("records terminal quality, cost, latency, tool and effect accounting", () => {
  const summary = summarizeSingleAgentRun({
    latencyMs: 42.7,
    quality: { alphaFixed: true, betaFixed: true, noiseIntact: true, testPasses: true },
    runRecord: { costUsd: "0.001", status: "completed", tokenUsage: { inputTokens: 10 } },
    toolCalls: [
      { risk: "read", status: "completed" },
      { risk: "write", status: "completed" },
      { risk: "execute", status: "failed" },
      { risk: "write", status: "blocked" }
    ],
    toolsUsed: ["file_read", "file_edit", "file_edit"]
  });

  assert.deepEqual(summary, {
    costState: "recorded",
    costUsd: "0.001",
    effectCount: 1,
    latencyMs: 43,
    quality: {
      alphaFixed: true,
      betaFixed: true,
      noiseIntact: true,
      passed: true,
      runCompleted: true,
      testPasses: true
    },
    runStatus: "completed",
    tokenUsage: { inputTokens: 10 },
    toolCount: 4,
    toolsUsed: ["file_read", "file_edit"],
    uncertainEffectCount: 1
  });
});

test("does not turn incomplete-run usage into a false zero-cost claim", () => {
  const summary = summarizeSingleAgentRun({
    latencyMs: 120_000,
    quality: { runCompleted: false },
    runRecord: { costUsd: "0", status: "failed", tokenUsage: {} },
    toolCalls: [{ risk: "write", status: "completed" }],
    toolsUsed: ["file_edit"]
  });

  assert.equal(summary.costState, "unknown");
  assert.equal(summary.costUsd, null);
  assert.equal(summary.tokenUsage, null);
  assert.equal(summary.effectCount, 1);
  assert.equal(summary.quality.passed, false);
});

test("derives completion from durable run status, never absence of an exception", () => {
  const summary = summarizeSingleAgentRun({
    latencyMs: 10,
    quality: {
      alphaFixed: true,
      betaFixed: true,
      noiseIntact: true,
      runCompleted: true,
      testPasses: true
    },
    runRecord: { costUsd: "0", status: "cancelled", tokenUsage: {} },
    toolCalls: [],
    toolsUsed: []
  });

  assert.equal(summary.runStatus, "cancelled");
  assert.equal(summary.quality.runCompleted, false);
  assert.equal(summary.quality.passed, false);
});

test("injects the exact baseline abort signal into in-flight tool execution", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const settled = [];
  const wrapped = createObservedBaselineTool(
    {
      definition: { name: "run_command", risk: "execute" },
      async execute(_args, context) {
        receivedSignal = context.signal;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("tool aborted")),
            { once: true }
          );
        });
      }
    },
    {
      onSettled: (event) => settled.push(event),
      signal: controller.signal
    }
  );

  const outcome = wrapped.execute({}, {});
  controller.abort();

  await assert.rejects(outcome, /tool aborted/u);
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(settled, [
    { name: "run_command", risk: "execute", status: "failed" }
  ]);
});

test("effect budget gate denies only effects beyond the shared cap", async () => {
  const gate = createEffectBudgetGate(1, () => ({ allowed: true }));

  assert.deepEqual(await gate({ risk: "read" }), { allowed: true });
  assert.deepEqual(await gate({ risk: "write" }), { allowed: true });
  assert.deepEqual(await gate({ risk: "execute" }), {
    allowed: false,
    reason: "single-agent baseline effect budget exhausted"
  });
});

test("builds an aggregate without raw prompts, outputs, or fixture paths", () => {
  const artifact = createSingleAgentBaselineArtifact({
    contract: contract(),
    generatedAt: "2026-07-29T00:00:00.000Z",
    model: "gemma4:12b",
    provider: "ollama",
    runs: [
      {
        costState: "recorded",
        costUsd: "0",
        effectCount: 2,
        latencyMs: 50,
        quality: { passed: true },
        runStatus: "completed",
        tokenUsage: {},
        toolCount: 3,
        toolsUsed: ["file_edit"],
        uncertainEffectCount: 0
      }
    ],
    source: { head: "a".repeat(40), tree: "clean" }
  });
  const serialized = JSON.stringify(artifact);

  assert.equal(artifact.aggregate.qualityRate, 1);
  assert.equal(artifact.aggregate.effectCount, 2);
  assert.equal(artifact.aggregate.costState, "recorded");
  assert.doesNotMatch(serialized, /prompt|output|\/tmp\//iu);
});

test("writes a 0600 artifact atomically and rejects symlink roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-baseline-test-"));
  try {
    const resultsDir = join(root, "results");
    const target = await writeSingleAgentBaselineArtifact({
      artifact: { schemaVersion: "test" },
      fileName: "baseline.json",
      resultsDir
    });
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { schemaVersion: "test" });

    const link = join(root, "link");
    await symlink(resultsDir, link);
    await assert.rejects(
      writeSingleAgentBaselineArtifact({
        artifact: {},
        fileName: "baseline.json",
        resultsDir: link
      }),
      /must not be a symlink/u
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("paired comparator keeps single-agent when the more complex arm has no quality gain", () => {
  const baseline = arm({ arm: "single-agent", passedRuns: 1 });
  const candidate = arm({ arm: "multi-agent", passedRuns: 1 });
  const comparison = createPairedAgentComparison({
    baseline,
    candidate,
    generatedAt: "2026-07-29T00:01:00.000Z",
    source: { evaluator: "independent", head: "b".repeat(40) }
  });

  assert.equal(comparison.decision.outcome, "keep-single-agent");
  assert.equal(comparison.decision.promotionApplied, false);
  assert.deepEqual(comparison.decision.reasonCodes, ["NO_QUALITY_GAIN"]);
  assert.equal(comparison.deltas.qualityRate, 0);
});

test("paired comparator blocks non-strict, unknown-cost, and uncertain-effect candidates", () => {
  const baseline = arm({ arm: "single-agent", passedRuns: 0 });
  const candidate = arm({
    arm: "multi-agent",
    costState: "unknown",
    passedRuns: 0,
    uncertainEffectCount: 1
  });
  const comparison = createPairedAgentComparison({
    baseline,
    candidate,
    generatedAt: "2026-07-29T00:01:00.000Z",
    source: { head: "b".repeat(40) }
  });

  assert.equal(comparison.decision.outcome, "keep-single-agent");
  assert.deepEqual(comparison.decision.reasonCodes, [
    "NO_QUALITY_GAIN",
    "CANDIDATE_NOT_STRICT_PASS",
    "COST_ACCOUNTING_UNKNOWN",
    "CANDIDATE_EFFECT_UNCERTAIN"
  ]);
  assert.equal(comparison.deltas.costUsd, null);
});

test("paired comparator rejects contract tampering and unfair model/provider changes", () => {
  const baseline = arm({ arm: "single-agent", passedRuns: 0 });
  const changedContract = contract({ datasetSeed: "other" });
  assert.throws(
    () => createPairedAgentComparison({
      baseline,
      candidate: arm({ arm: "multi-agent", contract: changedContract, passedRuns: 1 }),
      generatedAt: "2026-07-29T00:01:00.000Z",
      source: { head: "b".repeat(40) }
    }),
    /exact same fixture/u
  );

  const tampered = structuredClone(arm({ arm: "multi-agent", passedRuns: 1 }));
  tampered.contract.budget.wallclockMs += 1;
  assert.throws(
    () => createPairedAgentComparison({
      baseline,
      candidate: tampered,
      generatedAt: "2026-07-29T00:01:00.000Z",
      source: { head: "b".repeat(40) }
    }),
    /input hash is invalid/u
  );

  const otherModel = { ...arm({ arm: "multi-agent", passedRuns: 1 }), model: "other" };
  assert.throws(
    () => createPairedAgentComparison({
      baseline,
      candidate: otherModel,
      generatedAt: "2026-07-29T00:01:00.000Z",
      source: { head: "b".repeat(40) }
    }),
    /same model and provider/u
  );
});

test("paired comparator emits a report-only promotion recommendation only for strict known gain", async () => {
  const baseline = arm({ arm: "single-agent", passedRuns: 0 });
  const candidate = arm({ arm: "multi-agent", passedRuns: 1 });
  const comparison = createPairedAgentComparison({
    baseline,
    candidate,
    generatedAt: "2026-07-29T00:01:00.000Z",
    source: { evaluator: "independent", head: "b".repeat(40) }
  });
  assert.equal(comparison.decision.outcome, "promote-multi-agent");
  assert.equal(comparison.decision.promotionApplied, false);
  assert.deepEqual(comparison.decision.reasonCodes, []);

  const root = await mkdtemp(join(tmpdir(), "muse-paired-test-"));
  try {
    const target = await writeMultiAgentEvaluationArtifact({
      artifact: comparison,
      fileName: "paired.json",
      resultsDir: root
    });
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("paired comparator rejects declared-unknown cost and missing provenance metadata", () => {
  const baseline = arm({ arm: "single-agent", passedRuns: 0 });
  const inconsistent = structuredClone(arm({ arm: "multi-agent", passedRuns: 1 }));
  inconsistent.runs[0].costState = "unknown";
  assert.throws(
    () => createPairedAgentComparison({
      baseline,
      candidate: inconsistent,
      generatedAt: "2026-07-29T00:01:00.000Z",
      source: { head: "b".repeat(40) }
    }),
    /runs and aggregate are inconsistent/u
  );

  const missingMetadataBaseline = {
    ...baseline,
    generatedAt: undefined,
    model: undefined,
    provider: undefined,
    source: undefined
  };
  assert.throws(
    () => createPairedAgentComparison({
      baseline: missingMetadataBaseline,
      candidate: arm({ arm: "multi-agent", passedRuns: 1 }),
      generatedAt: undefined,
      source: undefined
    }),
    /model, provider, or provenance is invalid/u
  );

  assert.throws(
    () => createPairedAgentComparison({
      baseline,
      candidate: arm({ arm: "multi-agent", passedRuns: 1 }),
      generatedAt: "not-a-time",
      source: {}
    }),
    /timestamp or provenance is invalid/u
  );
});

test("baseline mode never reports an unavailable live dependency as a passing exit", async () => {
  const source = await readFile(
    new URL("./eval-two-edit-fix.mjs", import.meta.url),
    "utf8"
  );
  assert.equal(
    source.match(/process\.exit\(BASELINE_ARTIFACT \? 4 : 0\)/gu)?.length,
    4
  );
});
