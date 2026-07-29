import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const MULTI_AGENT_BASELINE_SCHEMA = "muse.multi-agent-baseline/v1";
export const MULTI_AGENT_PAIRED_COMPARISON_SCHEMA = "muse.multi-agent-paired-comparison/v1";
const SAFE_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}\.json$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonical(value[key])])
  );
}

export function stableSha256(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function createSingleAgentBaselineContract({
  budget,
  datasetSeed,
  fixture,
  rubric,
  taskFamily
}) {
  const contract = {
    budget,
    datasetSeed,
    fixture: {
      id: fixture.id,
      sha256: stableSha256(fixture.definition)
    },
    modelSeed: {
      control: "unsupported",
      value: null
    },
    rubric: {
      criteria: [...rubric.criteria],
      id: rubric.id,
      sha256: stableSha256(rubric.criteria)
    },
    taskFamily
  };
  return {
    ...contract,
    comparisonInputHash: stableSha256(contract)
  };
}

export function summarizeSingleAgentRun({
  latencyMs,
  quality,
  runRecord,
  toolCalls,
  toolsUsed
}) {
  const usageKnown = runRecord?.status === "completed";
  const normalizedQuality = {
    ...quality,
    runCompleted: runRecord?.status === "completed"
  };
  const effectCalls = toolCalls.filter(
    (call) => call.risk !== "read" && call.status === "completed"
  );
  const uncertainEffectCalls = toolCalls.filter(
    (call) => call.risk !== "read"
      && call.status !== "completed"
      && call.status !== "blocked"
  );
  return {
    costState: usageKnown ? "recorded" : "unknown",
    costUsd: usageKnown ? runRecord.costUsd : null,
    effectCount: effectCalls.length,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    quality: {
      ...normalizedQuality,
      passed: Object.values(normalizedQuality).every((value) => value === true)
    },
    runStatus: runRecord?.status ?? "unknown",
    tokenUsage: usageKnown ? runRecord.tokenUsage : null,
    toolCount: toolCalls.length,
    toolsUsed: [...new Set(toolsUsed)],
    uncertainEffectCount: uncertainEffectCalls.length
  };
}

export function createObservedBaselineTool(tool, {
  onSettled = () => {},
  onResult = () => {},
  signal
} = {}) {
  return {
    ...tool,
    async execute(args, context) {
      try {
        const result = await tool.execute(
          args,
          signal ? { ...context, signal } : context
        );
        onSettled({
          name: tool.definition.name,
          risk: tool.definition.risk,
          status: "completed"
        });
        onResult(args, result);
        return result;
      } catch (error) {
        onSettled({
          name: tool.definition.name,
          risk: tool.definition.risk,
          status: "failed"
        });
        throw error;
      }
    }
  };
}

export function createSingleAgentBaselineArtifact({
  contract,
  generatedAt,
  model,
  provider,
  runs,
  source
}) {
  const passedRuns = runs.filter((run) => run.quality.passed).length;
  const costsKnown = runs.every((run) =>
    run.costState === "recorded"
    && typeof run.costUsd === "string"
    && Number.isFinite(Number(run.costUsd))
  );
  return {
    aggregate: {
      costState: costsKnown ? "recorded" : "unknown",
      costUsd: costsKnown
        ? runs.reduce((sum, run) => sum + Number(run.costUsd), 0).toFixed(6)
        : null,
      effectCount: runs.reduce((sum, run) => sum + run.effectCount, 0),
      latencyMs: runs.reduce((sum, run) => sum + run.latencyMs, 0),
      passedRuns,
      qualityRate: runs.length === 0 ? 0 : passedRuns / runs.length,
      runCount: runs.length,
      toolCount: runs.reduce((sum, run) => sum + run.toolCount, 0),
      uncertainEffectCount: runs.reduce((sum, run) => sum + run.uncertainEffectCount, 0)
    },
    arm: "single-agent",
    contract,
    generatedAt,
    model,
    provider,
    runs,
    schemaVersion: MULTI_AGENT_BASELINE_SCHEMA,
    source
  };
}

export function createMultiAgentCandidateArtifact({
  contract,
  generatedAt,
  model,
  provider,
  runs,
  source
}) {
  return {
    ...createSingleAgentBaselineArtifact({
      contract,
      generatedAt,
      model,
      provider,
      runs,
      source
    }),
    arm: "multi-agent"
  };
}

function assertArmArtifact(artifact, expectedArm) {
  if (!artifact || typeof artifact !== "object") {
    throw new Error(`${expectedArm} artifact must be an object`);
  }
  if (artifact.schemaVersion !== MULTI_AGENT_BASELINE_SCHEMA || artifact.arm !== expectedArm) {
    throw new Error(`${expectedArm} artifact schema or arm is invalid`);
  }
  if (
    typeof artifact.model !== "string"
    || artifact.model.trim().length === 0
    || typeof artifact.provider !== "string"
    || artifact.provider.trim().length === 0
    || !isCanonicalTimestamp(artifact.generatedAt)
    || !artifact.source
    || typeof artifact.source !== "object"
    || typeof artifact.source.head !== "string"
    || !GIT_OBJECT_ID.test(artifact.source.head)
  ) {
    throw new Error(`${expectedArm} model, provider, or provenance is invalid`);
  }
  const { comparisonInputHash, ...contractInput } = artifact.contract ?? {};
  if (
    typeof comparisonInputHash !== "string"
    || comparisonInputHash !== stableSha256(contractInput)
  ) {
    throw new Error(`${expectedArm} comparison input hash is invalid`);
  }
  const aggregate = artifact.aggregate;
  const runs = artifact.runs;
  const nonNegativeCounts = [
    aggregate?.effectCount,
    aggregate?.latencyMs,
    aggregate?.toolCount,
    aggregate?.uncertainEffectCount
  ];
  if (
    !aggregate
    || !Number.isSafeInteger(aggregate.runCount)
    || aggregate.runCount < 1
    || !Number.isSafeInteger(aggregate.passedRuns)
    || aggregate.passedRuns < 0
    || aggregate.passedRuns > aggregate.runCount
    || typeof aggregate.qualityRate !== "number"
    || !Number.isFinite(aggregate.qualityRate)
    || aggregate.qualityRate < 0
    || aggregate.qualityRate > 1
    || nonNegativeCounts.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)
    || !["recorded", "unknown"].includes(aggregate.costState)
    || (aggregate.costState === "recorded"
      ? typeof aggregate.costUsd !== "string" || !Number.isFinite(Number(aggregate.costUsd))
      : aggregate.costUsd !== null)
  ) {
    throw new Error(`${expectedArm} aggregate is invalid`);
  }
  if (!Array.isArray(runs) || runs.length !== aggregate.runCount) {
    throw new Error(`${expectedArm} runs do not match the aggregate`);
  }
  const passedRuns = runs.filter((run) => run?.quality?.passed === true).length;
  const summed = (field) => runs.reduce((sum, run) => sum + Number(run?.[field]), 0);
  const costsKnown = runs.every((run) =>
    run?.costState === "recorded"
    && typeof run.costUsd === "string"
    && Number.isFinite(Number(run.costUsd))
    && Number(run.costUsd) >= 0
  );
  const expectedCost = costsKnown
    ? runs.reduce((sum, run) => sum + Number(run.costUsd), 0).toFixed(6)
    : null;
  if (
    runs.some((run) =>
      !run
      || typeof run !== "object"
      || !run.quality
      || typeof run.quality.passed !== "boolean"
      || !["recorded", "unknown"].includes(run.costState)
      || (run.costState === "recorded"
        ? typeof run.costUsd !== "string"
          || !Number.isFinite(Number(run.costUsd))
          || Number(run.costUsd) < 0
        : run.costUsd !== null)
      || ["effectCount", "latencyMs", "toolCount", "uncertainEffectCount"].some((field) =>
        typeof run[field] !== "number"
        || !Number.isFinite(run[field])
        || run[field] < 0
      )
      || (run.quality.passed && run.runStatus !== "completed")
    )
    || passedRuns !== aggregate.passedRuns
    || passedRuns / runs.length !== aggregate.qualityRate
    || summed("effectCount") !== aggregate.effectCount
    || summed("latencyMs") !== aggregate.latencyMs
    || summed("toolCount") !== aggregate.toolCount
    || summed("uncertainEffectCount") !== aggregate.uncertainEffectCount
    || costsKnown !== (aggregate.costState === "recorded")
    || expectedCost !== aggregate.costUsd
  ) {
    throw new Error(`${expectedArm} runs and aggregate are inconsistent`);
  }
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function numericDelta(candidate, baseline) {
  return Number(candidate) - Number(baseline);
}

/**
 * Compare one single-agent baseline and one more-complex multi-agent candidate.
 * This is report-only: the return value has no registry, policy, or runtime
 * activation seam. Unknown accounting or a non-strict candidate stays single.
 */
export function createPairedAgentComparison({
  baseline,
  candidate,
  generatedAt,
  source
}) {
  assertArmArtifact(baseline, "single-agent");
  assertArmArtifact(candidate, "multi-agent");
  if (
    !isCanonicalTimestamp(generatedAt)
    || !source
    || typeof source !== "object"
    || typeof source.head !== "string"
    || !GIT_OBJECT_ID.test(source.head)
  ) {
    throw new Error("paired comparison timestamp or provenance is invalid");
  }
  if (stableSha256(baseline.contract) !== stableSha256(candidate.contract)) {
    throw new Error("paired arms must use the exact same fixture, rubric, seed, and budget");
  }
  if (baseline.model !== candidate.model || baseline.provider !== candidate.provider) {
    throw new Error("single-vs-multi paired arms must use the same model and provider");
  }

  const qualityGain = numericDelta(candidate.aggregate.qualityRate, baseline.aggregate.qualityRate);
  const strictCandidatePass = candidate.aggregate.passedRuns === candidate.aggregate.runCount;
  const accountingKnown = baseline.aggregate.costState === "recorded"
    && candidate.aggregate.costState === "recorded";
  const noUncertainEffects = candidate.aggregate.uncertainEffectCount === 0;
  const reasons = [
    ...(qualityGain > 0 ? [] : ["NO_QUALITY_GAIN"]),
    ...(strictCandidatePass ? [] : ["CANDIDATE_NOT_STRICT_PASS"]),
    ...(accountingKnown ? [] : ["COST_ACCOUNTING_UNKNOWN"]),
    ...(noUncertainEffects ? [] : ["CANDIDATE_EFFECT_UNCERTAIN"])
  ];
  const promote = reasons.length === 0;
  const costUsdDelta = accountingKnown
    ? numericDelta(candidate.aggregate.costUsd, baseline.aggregate.costUsd).toFixed(6)
    : null;

  return Object.freeze({
    arms: Object.freeze({
      multiAgentArtifactHash: stableSha256(candidate),
      singleAgentArtifactHash: stableSha256(baseline)
    }),
    contract: baseline.contract,
    decision: Object.freeze({
      outcome: promote ? "promote-multi-agent" : "keep-single-agent",
      promotionApplied: false,
      reasonCodes: Object.freeze(reasons)
    }),
    deltas: Object.freeze({
      costState: accountingKnown ? "recorded" : "unknown",
      costUsd: costUsdDelta,
      effectCount: numericDelta(candidate.aggregate.effectCount, baseline.aggregate.effectCount),
      latencyMs: numericDelta(candidate.aggregate.latencyMs, baseline.aggregate.latencyMs),
      qualityRate: qualityGain,
      toolCount: numericDelta(candidate.aggregate.toolCount, baseline.aggregate.toolCount),
      uncertainEffectCount: numericDelta(
        candidate.aggregate.uncertainEffectCount,
        baseline.aggregate.uncertainEffectCount
      )
    }),
    generatedAt,
    model: baseline.model,
    provider: baseline.provider,
    schemaVersion: MULTI_AGENT_PAIRED_COMPARISON_SCHEMA,
    source
  });
}

export function createEffectBudgetGate(maxEffects, delegate) {
  let admittedEffects = 0;
  return async (input) => {
    const delegated = await delegate(input);
    if (!delegated.allowed || input.risk === "read") return delegated;
    if (admittedEffects >= maxEffects) {
      return { allowed: false, reason: "single-agent baseline effect budget exhausted" };
    }
    admittedEffects += 1;
    return delegated;
  };
}

export async function writeMultiAgentEvaluationArtifact({
  artifact,
  fileName,
  resultsDir
}) {
  if (!SAFE_FILE_NAME.test(fileName) || basename(fileName) !== fileName) {
    throw new Error("invalid baseline artifact file name");
  }
  const requestedRoot = resolve(resultsDir);
  await mkdir(requestedRoot, { recursive: true });
  if ((await lstat(requestedRoot)).isSymbolicLink()) {
    throw new Error("baseline artifact directory must not be a symlink");
  }
  const root = await realpath(requestedRoot);
  const target = join(root, fileName);
  const temporary = join(root, `.${fileName}.${process.pid.toString()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    await rename(temporary, target);
    await chmod(target, 0o600);
    return target;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeSingleAgentBaselineArtifact(options) {
  return writeMultiAgentEvaluationArtifact(options);
}
