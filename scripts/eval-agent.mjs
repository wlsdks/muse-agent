/**
 * Capability-oriented live agent evaluation.
 *
 * Every row must emit one versioned completion marker. Exit zero without that
 * evidence is a failure, and stochastic rows pass only when all three requested
 * trials executed and passed. `--json` keeps stdout machine-only and never
 * copies prompts, model output, or tool payloads into the report.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCapabilityExecutionAdmission,
  describeCapabilityExecutionAdmission,
  parseCapabilityExecutionRequest,
  readCapabilityResourceSnapshot,
} from "./eval-agent-admission.mjs";
import { classifySkip, parseCompletion } from "./eval-skip.mjs";
import {
  buildAndPublishRunner,
  captureGitSourceSnapshot,
  captureRuntimeArtifacts,
  runForcedTypeScriptBuild,
} from "./eval-agent-provenance.mjs";
import {
  beginCapabilityEvidenceAttempt,
  DEFAULT_CAPABILITY_REPORT_PATH,
  finalizeCapabilityEvidenceAttempt,
} from "./eval-agent-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_TIMEOUT_MS = 90 * 60 * 1000;
const REPO_ROOT = resolve(here, "..");
export const CAPABILITY_MATRIX_ID = "muse-agent-capability-v1";

const HELP_FLAGS = new Set(["--help", "-h"]);
const PREFLIGHT_FLAG = "--preflight";
const ADMISSION_FLAG = "--admit";
const EXECUTE_FLAG = "--execute";

export const CAPABILITIES = Object.freeze([
  { id: "tool-selection-arguments", battery: "eval-tool-selection.mjs", required: true, repeats: 3 },
  { id: "plan-quality", battery: "eval-plan-quality.mjs", required: true, repeats: 3 },
  { id: "tool-argument-grounding", battery: "../apps/cli/scripts/verify-tool-arg-grounding.mjs", required: true, repeats: 3 },
  { id: "computer-task-terminal-edit", battery: "eval-computer-task.mjs", required: true, repeats: 3 },
  { id: "adversarial-containment-no-op", battery: "eval-adversarial.mjs", required: true, repeats: 3 },
  { id: "cosine-recall-abstention", battery: "eval-recall-quality.mjs", required: true, repeats: 1 },
  { id: "multihop-retrieval-lift", battery: "verify-multihop.mjs", required: true, repeats: 1 },
  { id: "orchestration-failure-bounds", battery: "verify-orchestration.mjs", required: true, repeats: 3 },
  { id: "channel-conversation-rhythm", battery: "eval-channel-rhythm.mjs", required: true, repeats: 3 },
  { id: "edit-run-verify", battery: "eval-edit-run-verify.mjs", required: false, repeats: 3 },
  { id: "browser-terminal-task", battery: "eval-browser-agent.mjs", required: false, repeats: 3 },
]);

const CAPABILITY_REQUIREMENTS = Object.freeze({
  "tool-selection-arguments": ["local-ollama-generation-model"],
  "plan-quality": ["local-ollama-generation-model"],
  "tool-argument-grounding": ["local-ollama-generation-model"],
  "computer-task-terminal-edit": ["local-ollama-generation-model"],
  "adversarial-containment-no-op": ["local-ollama-generation-model", "local-runner", "sandbox"],
  "cosine-recall-abstention": ["local-ollama-embedding-model"],
  "multihop-retrieval-lift": ["local-ollama-embedding-model", "fresh-typescript-artifacts"],
  "orchestration-failure-bounds": ["local-ollama-generation-model"],
  "channel-conversation-rhythm": ["local-ollama-generation-model"],
  "edit-run-verify": ["local-ollama-generation-model", "local-runner"],
  "browser-terminal-task": ["local-ollama-generation-model", "compatible-local-chrome"],
});

const PREFLIGHT_REQUIRED_BEFORE_RUN = Object.freeze([
  "clean source snapshot before, after, and at end of the run",
  "fresh TypeScript build and freshly published local runner artifact",
  "local Ollama generation model (MUSE_EVAL_MODEL or gemma4:12b)",
  "local embedding model for retrieval axes (default nomic-embed-text-v2-moe)",
  "sandbox for adversarial containment; compatible local Chrome for the optional browser axis",
  "owner confirms the machine is idle and accepts the stated resource budget",
]);

const RECOGNIZED_ENVIRONMENT_SKIPS = new Set([
  "chrome-missing",
  "embed-model-missing",
  "model-missing",
  "ollama-unreachable",
  "runner-missing",
  "runtime-unavailable",
  "sandbox-missing",
]);

const REPORT_REASON_CODES = new Set([
  "artifact-provenance-unverified",
  "battery-reported-failure",
  "chrome-missing",
  "duplicate-completion",
  "embed-model-missing",
  "exit-nonzero",
  "invalid-completion",
  "missing-completion",
  "missing-skip-evidence",
  "model-missing",
  "ollama-unreachable",
  "orchestration-invariant-failed",
  "regression",
  "report-integrity-failed",
  "report-persistence-failed",
  "requested-repeat-mismatch",
  "runner-build-failed",
  "runner-missing",
  "runner-publish-failed",
  "runtime-execution-failed",
  "runtime-unavailable",
  "sandbox-missing",
  "signal",
  "skip-reason-mismatch",
  "source-provenance-unverified",
  "spawn-error",
  "terminal-state-assertion-failed",
  "terminal-state-failed",
  "threshold-not-met",
  "typescript-build-failed",
  "unexpected-skip",
  "unrecognized-skip",
]);

function failedRow(capability, durationMs, reason, executed = 0) {
  return {
    id: capability.id,
    required: capability.required,
    status: "failed",
    requested: capability.repeats,
    executed,
    reason,
    durationMs,
  };
}

/** Convert a child-process result into a privacy-safe, fail-closed row. */
export function classifyCapabilityResult(capability, child) {
  const durationMs = Math.max(0, Math.round(child.durationMs ?? 0));
  if (child.error) {
    return failedRow(capability, durationMs, "spawn-error");
  }
  if (child.signal) {
    return failedRow(capability, durationMs, "signal");
  }
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const parsed = parseCompletion(output);
  if (child.status !== 0) {
    return failedRow(
      capability,
      durationMs,
      "exit-nonzero",
      parsed.ok ? parsed.completion.executed : 0
    );
  }

  if (!parsed.ok) {
    return failedRow(capability, durationMs, parsed.reason);
  }

  const { completion } = parsed;
  if (completion.requested !== capability.repeats) {
    return failedRow(capability, durationMs, "requested-repeat-mismatch", completion.executed);
  }

  const skipCode = classifySkip(output);
  if (completion.status === "passed") {
    if (skipCode) {
      return failedRow(capability, durationMs, "unexpected-skip", completion.executed);
    }
    return {
      id: capability.id,
      required: capability.required,
      status: "passed",
      requested: capability.repeats,
      executed: completion.executed,
      durationMs,
    };
  }

  if (completion.status === "failed") {
    return failedRow(capability, durationMs, "battery-reported-failure", completion.executed);
  }

  if (!skipCode || !RECOGNIZED_ENVIRONMENT_SKIPS.has(skipCode)) {
    return failedRow(capability, durationMs, skipCode ? "unrecognized-skip" : "missing-skip-evidence", completion.executed);
  }
  if (completion.reason !== skipCode) {
    return failedRow(capability, durationMs, "skip-reason-mismatch", completion.executed);
  }
  return {
    id: capability.id,
    required: capability.required,
    status: "unverified",
    requested: capability.repeats,
    executed: completion.executed,
    reason: completion.reason,
    durationMs,
  };
}

/** Build the stable JSON schema and compute the required-row gate. */
export function createCapabilityReport(capabilities, options = {}) {
  const canonicalRows = canonicalCapabilityRows(capabilities);
  const counts = {
    passed: canonicalRows.filter((row) => row.status === "passed").length,
    failed: canonicalRows.filter((row) => row.status === "failed").length,
    unverified: canonicalRows.filter((row) => row.status === "unverified").length,
    total: canonicalRows.length,
  };
  const required = canonicalRows.filter((row) => row.required);
  const status = canonicalRows.some((row) => row.status === "failed")
    ? "failed"
    : required.some((row) => row.status !== "passed")
      ? "unverified"
      : "passed";
  return {
    version: 2,
    matrixId: CAPABILITY_MATRIX_ID,
    generatedAt: options.generatedAt ?? new Date(0).toISOString(),
    status,
    counts,
    capabilities: canonicalRows,
    provenance: sanitizeProvenance(options.provenance),
  };
}

function canonicalCapabilityRows(rows) {
  if (!Array.isArray(rows) || rows.length !== CAPABILITIES.length) {
    return integrityFailureRows();
  }
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || byId.has(row.id)) {
      return integrityFailureRows();
    }
    byId.set(row.id, row);
  }

  const canonical = [];
  for (const capability of CAPABILITIES) {
    const row = byId.get(capability.id);
    if (!isCanonicalCapabilityRow(row, capability)) return integrityFailureRows();
    canonical.push({ ...row });
  }
  return canonical;
}

function isCanonicalCapabilityRow(row, capability) {
  if (!row || row.id !== capability.id || row.required !== capability.required || row.requested !== capability.repeats) {
    return false;
  }
  const expectedKeys = row.reason === undefined
    ? ["durationMs", "executed", "id", "requested", "required", "status"]
    : ["durationMs", "executed", "id", "reason", "requested", "required", "status"];
  const keys = Object.keys(row).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
  if (!Number.isSafeInteger(row.executed) || row.executed < 0 || row.executed > capability.repeats) return false;
  if (!Number.isSafeInteger(row.durationMs) || row.durationMs < 0) return false;
  if (row.status !== "passed" && row.status !== "failed" && row.status !== "unverified") return false;
  if (row.status === "passed") return row.executed === capability.repeats && row.reason === undefined;
  return REPORT_REASON_CODES.has(row.reason);
}

function integrityFailureRows() {
  return CAPABILITIES.map((capability) => failedRow(capability, 0, "report-integrity-failed"));
}

/** Compatibility helper for tests/tools that publish one complete attempt. */
export function persistCapabilityReport(report, reportPath = DEFAULT_CAPABILITY_REPORT_PATH, options = {}) {
  const attempt = beginCapabilityEvidenceAttempt({ ...options, reportPath });
  finalizeCapabilityEvidenceAttempt(attempt, report, options);
}

function printHumanReport(report, stdout) {
  stdout.write("\n=== eval:agent capability summary ===\n");
  for (const row of report.capabilities) {
    const tag = row.status === "passed" ? "PASS" : row.status === "failed" ? "FAIL" : "UNVERIFIED";
    const reason = row.reason ? ` (${row.reason})` : "";
    stdout.write(`  ${tag.padEnd(10)} ${row.id} ${row.executed}/${row.requested}${reason}\n`);
  }
  stdout.write(
    `eval:agent ${report.status.toUpperCase()} — ${report.counts.passed} pass, ${report.counts.unverified} unverified, ${report.counts.failed} fail\n`
  );
}

function printUsage(stdout) {
  stdout.write(
    "Usage: pnpm eval:agent -- [--preflight | --admit | --execute --confirm-idle --budget-minutes <minutes>] [--json]\n\n"
    + "Runs the full 11-axis local capability gate (builds fresh artifacts and may load local models).\n"
    + "Use --preflight to inspect its static requirements and resource budget without builds, probes, model calls, or writes.\n"
    + "Use --admit with --confirm-idle and --budget-minutes to check live local readiness without builds, probes, model calls, or writes.\n"
    + "Use --execute with the same owner confirmation and sufficient budget to start the full gate.\n"
    + "Use --json for a privacy-safe machine-readable report.\n"
  );
}

/**
 * A deliberately static plan for the expensive capability gate. This is not a
 * readiness check: it does not inspect git, spawn a child, touch a runner,
 * connect to Ollama, or write a report. Keeping those operations out makes
 * discovery safe on a working laptop.
 */
export function createCapabilityPreflight(capabilities = CAPABILITIES) {
  const axes = capabilities.map((capability) => ({
    battery: capability.battery,
    id: capability.id,
    repeats: capability.repeats,
    required: capability.required,
    requirements: CAPABILITY_REQUIREMENTS[capability.id] ?? [],
  }));
  const requiredAxes = axes.filter((axis) => axis.required).length;
  const requestedTrials = axes.reduce((total, axis) => total + axis.repeats, 0);
  return {
    version: 1,
    matrixId: CAPABILITY_MATRIX_ID,
    mode: "plan-only",
    qualification: "unverified",
    sideEffects: "none",
    requiredBeforeRun: PREFLIGHT_REQUIRED_BEFORE_RUN,
    resourceBudget: {
      batteryProcesses: axes.length,
      hardSequentialTimeoutMinutes: (axes.length * CAPABILITY_TIMEOUT_MS) / 60_000,
      perBatteryTimeoutMinutes: CAPABILITY_TIMEOUT_MS / 60_000,
      requestedTrials,
    },
    summary: {
      optionalAxes: axes.length - requiredAxes,
      requiredAxes,
      totalAxes: axes.length,
    },
    axes,
  };
}

function printPreflight(preflight, stdout) {
  stdout.write("\n=== eval:agent capability preflight (plan only) ===\n");
  for (const axis of preflight.axes) {
    const tier = axis.required ? "REQUIRED" : "OPTIONAL";
    stdout.write(`  ${tier.padEnd(10)} ${axis.id} pass^${axis.repeats.toString()} — ${axis.requirements.join(", ")}\n`);
  }
  stdout.write(
    `\nresource budget: ${preflight.resourceBudget.batteryProcesses.toString()} sequential batteries, `
    + `${preflight.resourceBudget.requestedTrials.toString()} requested trials, `
    + `${preflight.resourceBudget.perBatteryTimeoutMinutes.toString()} min hard cap each, `
    + `${preflight.resourceBudget.hardSequentialTimeoutMinutes.toString()} min worst-case total\n`
    + "qualification: UNVERIFIED — this command performed no build, probe, model call, battery run, or report write.\n"
  );
}

export function createCapabilityExecutionAdmissionForArgs(args, dependencies = {}) {
  const preflight = createCapabilityPreflight();
  const request = parseCapabilityExecutionRequest(args);
  let snapshot;
  try {
    snapshot = (dependencies.readResourceSnapshot ?? readCapabilityResourceSnapshot)();
  } catch {
    snapshot = undefined;
  }
  return createCapabilityExecutionAdmission({
    matrixId: preflight.matrixId,
    requiredBudgetMinutes: preflight.resourceBudget.hardSequentialTimeoutMinutes,
    request,
    snapshot,
  });
}

function printAdmission(admission, stdout) {
  stdout.write("\n=== eval:agent execution admission (read only) ===\n" + describeCapabilityExecutionAdmission(admission) + "\n");
  if (admission.status === "defer") {
    stdout.write(
      "next: inspect with --admit --confirm-idle --budget-minutes 990; "
      + "start only with --execute --confirm-idle --budget-minutes 990.\n"
    );
  }
}

function emitAdmission(admission, { json, stdout }) {
  if (json) stdout.write(JSON.stringify(admission) + "\n");
  else printAdmission(admission, stdout);
  if (admission.status !== "admit") process.exitCode = 1;
  return admission;
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const spawn = dependencies.spawn ?? spawnSync;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const now = dependencies.now ?? Date.now;
  if (args.some((arg) => HELP_FLAGS.has(arg))) {
    printUsage(stdout);
    return undefined;
  }
  const json = args.includes("--json");
  if (args.includes(PREFLIGHT_FLAG)) {
    const preflight = createCapabilityPreflight();
    if (json) stdout.write(`${JSON.stringify(preflight)}\n`);
    else printPreflight(preflight, stdout);
    return preflight;
  }
  const admissionRequested = args.includes(ADMISSION_FLAG);
  const executionRequested = args.includes(EXECUTE_FLAG);
  const admission = createCapabilityExecutionAdmissionForArgs(args, dependencies);
  if (admissionRequested && executionRequested) {
    return emitAdmission(
      { ...admission, reasons: ["conflicting-admission-mode"], status: "defer" },
      { json, stdout }
    );
  }
  if (admissionRequested || !executionRequested || admission.status !== "admit") {
    return emitAdmission(admission, { json, stdout });
  }
  const captureSource = dependencies.captureSource
    ?? (() => captureGitSourceSnapshot({ repoRoot: REPO_ROOT }));
  const runTypeScriptBuild = dependencies.runTypeScriptBuild
    ?? (() => runForcedTypeScriptBuild({ repoRoot: REPO_ROOT }));
  const buildRunnerArtifact = dependencies.buildRunnerArtifact
    ?? (() => buildAndPublishRunner({ repoRoot: REPO_ROOT }));
  const captureArtifacts = dependencies.captureArtifacts
    ?? ((runnerPath) => captureRuntimeArtifacts({ repoRoot: REPO_ROOT, runnerPath }));

  let evidenceAttempt;
  try {
    evidenceAttempt = dependencies.beginAttempt?.();
  } catch {
    const report = createCapabilityReport(
      CAPABILITIES.map((capability) => failedRow(capability, 0, "report-persistence-failed")),
      { generatedAt: generatedAt(now), provenance: unknownProvenance() },
    );
    return emitUnpersistedReport(report, { json, stdout });
  }

  const sourceBeforeBuild = safeSourceSnapshot(captureSource);
  const typeScriptBuild = safeBuildStep(runTypeScriptBuild, "typescript-build-failed");
  if (!typeScriptBuild.ok) {
    return finishBuildFailure(typeScriptBuild.reason, {
      captureArtifacts,
      captureSource,
      dependencies,
      evidenceAttempt,
      json,
      now,
      sourceBeforeBuild,
      stderr,
      stdout,
    });
  }

  const runnerBuild = safeBuildStep(buildRunnerArtifact, "runner-build-failed");
  if (!runnerBuild.ok || typeof runnerBuild.runnerPath !== "string") {
    return finishBuildFailure(runnerBuild.reason ?? "runner-build-failed", {
      captureArtifacts,
      captureSource,
      dependencies,
      evidenceAttempt,
      json,
      now,
      sourceBeforeBuild,
      stderr,
      stdout,
    });
  }
  const runnerPath = runnerBuild.runnerPath;
  const sourceAfterBuild = safeSourceSnapshot(captureSource);
  const artifactsAfterBuild = safeArtifactSnapshot(() => captureArtifacts(runnerPath));
  const rows = [];

  for (const capability of CAPABILITIES) {
    const startedAt = now();
    if (json) {
      stderr.write(`eval:agent running ${capability.id}\n`);
    } else {
      stdout.write(`\n=== eval:agent → ${capability.id} ===\n`);
    }
    const child = spawn(process.execPath, [join(here, capability.battery)], {
      encoding: "utf8",
      env: {
        ...process.env,
        MUSE_EVAL_REPEAT: String(capability.repeats),
        MUSE_RUNNER_PATH: runnerPath,
      },
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CAPABILITY_TIMEOUT_MS,
    });
    const withDuration = { ...child, durationMs: now() - startedAt };
    if (!json) {
      stdout.write(child.stdout ?? "");
      stderr.write(child.stderr ?? "");
    }
    const row = classifyCapabilityResult(capability, withDuration);
    rows.push(row);
    if (json) {
      stderr.write(`eval:agent ${capability.id} ${row.status}\n`);
    }
  }

  const sourceAtEnd = safeSourceSnapshot(captureSource);
  const artifactsAtEnd = safeArtifactSnapshot(() => captureArtifacts(runnerPath));
  const provenance = {
    sourceBeforeBuild,
    sourceAfterBuild,
    sourceAtEnd,
    artifactsAfterBuild,
    artifactsAtEnd,
  };
  const report = createCapabilityReport(applyProvenanceGate(rows, provenance), {
    generatedAt: generatedAt(now),
    provenance,
  });
  return emitReport(report, { dependencies, evidenceAttempt, json, stderr, stdout });
}

function finishBuildFailure(reason, context) {
  const sourceAfterBuild = safeSourceSnapshot(context.captureSource);
  const sourceAtEnd = safeSourceSnapshot(context.captureSource);
  const artifactsAfterBuild = { count: 0, status: "unknown" };
  const artifactsAtEnd = { count: 0, status: "unknown" };
  const rows = CAPABILITIES.map((capability) => failedRow(capability, 0, reason));
  const report = createCapabilityReport(rows, {
    generatedAt: generatedAt(context.now),
    provenance: {
      sourceBeforeBuild: context.sourceBeforeBuild,
      sourceAfterBuild,
      sourceAtEnd,
      artifactsAfterBuild,
      artifactsAtEnd,
    },
  });
  return emitReport(report, context);
}

function emitReport(report, { dependencies, evidenceAttempt, json, stdout }) {
  let emittedReport = report;
  try {
    if (dependencies.finishAttempt) {
      if (!evidenceAttempt) throw new Error("capability evidence attempt missing");
      dependencies.finishAttempt(evidenceAttempt, report);
    } else {
      dependencies.writeReport?.(report);
    }
  } catch {
    emittedReport = createCapabilityReport(
      CAPABILITIES.map((capability) => failedRow(capability, 0, "report-persistence-failed")),
      { generatedAt: report.generatedAt, provenance: report.provenance },
    );
  }
  if (json) stdout.write(`${JSON.stringify(emittedReport)}\n`);
  else printHumanReport(emittedReport, stdout);
  if (emittedReport.status !== "passed") process.exitCode = 1;
  return emittedReport;
}

function emitUnpersistedReport(report, { json, stdout }) {
  if (json) stdout.write(`${JSON.stringify(report)}\n`);
  else printHumanReport(report, stdout);
  process.exitCode = 1;
  return report;
}

function safeBuildStep(step, fallbackReason) {
  try {
    const result = step();
    return result && typeof result === "object" ? result : { ok: false, reason: fallbackReason };
  } catch {
    return { ok: false, reason: fallbackReason };
  }
}

function safeSourceSnapshot(capture) {
  try {
    const snapshot = capture();
    if (snapshot?.tree === "clean" || snapshot?.tree === "dirty" || snapshot?.tree === "unknown") {
      const revision = typeof snapshot.revision === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(snapshot.revision)
        ? snapshot.revision
        : undefined;
      return {
        ...(revision ? { revision } : {}),
        tree: snapshot.tree === "clean" && !revision ? "unknown" : snapshot.tree,
      };
    }
  } catch {
    // Closed below.
  }
  return { tree: "unknown" };
}

function safeArtifactSnapshot(capture) {
  try {
    const snapshot = capture();
    if (
      snapshot?.status === "ok"
      && typeof snapshot.digest === "string"
      && /^[a-f0-9]{64}$/u.test(snapshot.digest)
      && Number.isSafeInteger(snapshot.count)
      && snapshot.count > 0
    ) {
      return { count: snapshot.count, digest: snapshot.digest, status: "ok" };
    }
  } catch {
    // Closed below.
  }
  return { count: 0, status: "unknown" };
}

function applyProvenanceGate(rows, provenance) {
  const sources = [
    provenance.sourceBeforeBuild,
    provenance.sourceAfterBuild,
    provenance.sourceAtEnd,
  ];
  const revisions = sources.map((snapshot) => snapshot.revision);
  const sourceOk = sources.every((snapshot) => snapshot.tree === "clean")
    && revisions.every((revision) => typeof revision === "string" && revision.length > 0)
    && revisions.every((revision) => revision === revisions[0]);
  if (!sourceOk) return downgradePassedRows(rows, "source-provenance-unverified");

  const afterBuild = provenance.artifactsAfterBuild;
  const atEnd = provenance.artifactsAtEnd;
  const artifactOk = afterBuild.status === "ok"
    && atEnd.status === "ok"
    && afterBuild.count > 0
    && atEnd.count === afterBuild.count
    && typeof afterBuild.digest === "string"
    && /^[a-f0-9]{64}$/u.test(afterBuild.digest)
    && atEnd.digest === afterBuild.digest;
  return artifactOk ? rows : downgradePassedRows(rows, "artifact-provenance-unverified");
}

function downgradePassedRows(rows, reason) {
  return rows.map((row) => row.status === "passed" ? { ...row, reason, status: "unverified" } : row);
}

function generatedAt(now) {
  try {
    return new Date(now()).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function unknownProvenance() {
  return {
    sourceBeforeBuild: { tree: "unknown" },
    sourceAfterBuild: { tree: "unknown" },
    sourceAtEnd: { tree: "unknown" },
    artifactsAfterBuild: { count: 0, status: "unknown" },
    artifactsAtEnd: { count: 0, status: "unknown" },
  };
}

function sanitizeProvenance(provenance) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return unknownProvenance();
  }
  return {
    sourceBeforeBuild: safeSourceSnapshot(() => provenance.sourceBeforeBuild),
    sourceAfterBuild: safeSourceSnapshot(() => provenance.sourceAfterBuild),
    sourceAtEnd: safeSourceSnapshot(() => provenance.sourceAtEnd),
    artifactsAfterBuild: safeArtifactSnapshot(() => provenance.artifactsAfterBuild),
    artifactsAtEnd: safeArtifactSnapshot(() => provenance.artifactsAtEnd),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), {
    beginAttempt: () => beginCapabilityEvidenceAttempt({ allowedRoot: REPO_ROOT }),
    finishAttempt: (attempt, report) => finalizeCapabilityEvidenceAttempt(attempt, report),
  });
}
