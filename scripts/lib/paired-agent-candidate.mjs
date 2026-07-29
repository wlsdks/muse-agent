import {
  createMultiAgentCandidateArtifact,
  createPairedAgentComparison
} from "./multi-agent-baseline.mjs";

const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const COST_USD = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export function resolveLocalOllamaBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Ollama base URL is invalid");
  }
  if (
    url.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new Error("Ollama base URL must be credential-free HTTP loopback");
  }
  return url.href.replace(/\/+$/u, "");
}

export function assertCurrentPairedBaseline({
  baseline,
  fixtureHash,
  head,
  upstream,
  worktree
}) {
  if (
    !GIT_OBJECT_ID.test(head)
    || !GIT_OBJECT_ID.test(upstream)
    || baseline?.arm !== "single-agent"
    || baseline?.source?.head !== head
    || baseline?.source?.upstream !== upstream
    || baseline?.source?.worktree !== "clean"
    || worktree !== "clean"
  ) {
    throw new Error("single-agent baseline and candidate must share the current clean HEAD/upstream");
  }
  if (baseline.contract?.fixture?.sha256 !== fixtureHash) {
    throw new Error("paired fixture does not match the frozen single-agent contract");
  }
  const budget = baseline.contract?.budget;
  if (
    budget?.repeatCount !== 1
    || !Number.isSafeInteger(budget.maxEffects)
    || budget.maxEffects < 0
    || !Number.isSafeInteger(budget.wallclockMs)
    || budget.wallclockMs < 1
    || budget.wallclockMs > 120_000
  ) {
    throw new Error("baseline budget is invalid or exceeds the 120-second paired cap");
  }
  return budget;
}

export function assessPairedExecution({
  blockedToolCalls,
  childRecords,
  expectedChildRunIds,
  requestedWorkerIds,
  result,
  uncertainToolCalls
}) {
  const reasons = [];
  const steps = result?.results;
  const stepIds = Array.isArray(steps) ? steps.map((step) => step.workerId) : [];
  const recordIds = childRecords.map((record) => record?.id);
  if (
    stepIds.length !== requestedWorkerIds.length
    || new Set(stepIds).size !== stepIds.length
    || stepIds.some((id, index) => id !== requestedWorkerIds[index])
  ) {
    reasons.push("ORCHESTRATION_WORKERS_MISMATCH");
  }
  if (!Array.isArray(steps) || steps.some((step) => step.status !== "completed")) {
    reasons.push("ORCHESTRATION_STEP_NOT_COMPLETED");
  }
  if (
    expectedChildRunIds.length !== requestedWorkerIds.length
    || new Set(expectedChildRunIds).size !== expectedChildRunIds.length
    || recordIds.length !== requestedWorkerIds.length
    || new Set(recordIds).size !== recordIds.length
    || recordIds.some((id, index) => id !== expectedChildRunIds[index])
    || childRecords.some((record) => record?.status !== "completed")
  ) {
    reasons.push("CHILD_HISTORY_NOT_COMPLETED");
  }
  if (blockedToolCalls.length > 0) {
    reasons.push("TOOL_CALL_BLOCKED");
  }
  if (uncertainToolCalls.length > 0) {
    reasons.push("TOOL_EFFECT_UNCERTAIN");
  }
  return Object.freeze({ ok: reasons.length === 0, reasonCodes: Object.freeze(reasons) });
}

export function createCombinedChildRunRecord(childRecords, execution) {
  if (!execution.ok) return undefined;
  if (childRecords.some((record) =>
    typeof record?.costUsd !== "string"
    || !COST_USD.test(record.costUsd)
    || !Number.isFinite(Number(record.costUsd))
    || Number(record.costUsd) < 0
  )) {
    return undefined;
  }
  const tokenUsage = {};
  for (const record of childRecords) {
    for (const [key, value] of Object.entries(record.tokenUsage ?? {})) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        tokenUsage[key] = (tokenUsage[key] ?? 0) + value;
      }
    }
  }
  return Object.freeze({
    costUsd: childRecords.reduce((sum, record) => sum + Number(record.costUsd), 0).toFixed(6),
    status: "completed",
    tokenUsage: Object.freeze(tokenUsage)
  });
}

export function stagePairedAgentArtifacts({
  baseline,
  candidateInput,
  comparisonGeneratedAt,
  comparisonSource
}) {
  const candidate = createMultiAgentCandidateArtifact(candidateInput);
  const comparison = createPairedAgentComparison({
    baseline,
    candidate,
    generatedAt: comparisonGeneratedAt,
    source: comparisonSource
  });
  return Object.freeze({ candidate, comparison });
}
