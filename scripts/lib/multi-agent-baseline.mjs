import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const MULTI_AGENT_BASELINE_SCHEMA = "muse.multi-agent-baseline/v1";
const SAFE_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,127}\.json$/u;

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
  const costsKnown = runs.every((run) => run.costUsd !== null);
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

export async function writeSingleAgentBaselineArtifact({
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
