import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export const CAPABILITY_EVIDENCE_SCHEMA_VERSION = 1;
export const CAPABILITY_AXIS_PROGRESS_SCHEMA_VERSION = 1;
const CAPABILITY_MATRIX_ID = "muse-agent-capability-v1";
const CAPABILITY_MATRIX = Object.freeze([
  { id: "tool-selection-arguments", required: true, repeats: 3 },
  { id: "plan-quality", required: true, repeats: 3 },
  { id: "tool-argument-grounding", required: true, repeats: 3 },
  { id: "computer-task-terminal-edit", required: true, repeats: 3 },
  { id: "adversarial-containment-no-op", required: true, repeats: 3 },
  { id: "cosine-recall-abstention", required: true, repeats: 1 },
  { id: "multihop-retrieval-lift", required: true, repeats: 1 },
  { id: "orchestration-failure-bounds", required: true, repeats: 3 },
  { id: "channel-conversation-rhythm", required: true, repeats: 3 },
  { id: "edit-run-verify", required: false, repeats: 3 },
  { id: "browser-terminal-task", required: false, repeats: 3 },
]);
const CAPABILITY_REPORT_REASON_CODES = new Set([
  "artifact-provenance-unverified",
  "battery-reported-failure",
  "chrome-missing",
  "duplicate-completion",
  "embed-model-missing",
  "evaluation-deadline-exhausted",
  "exit-nonzero",
  "invalid-completion",
  "missing-completion",
  "missing-skip-evidence",
  "model-missing",
  "not-selected",
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
export const DEFAULT_CAPABILITY_REPORT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.muse-dev/evals/agent-capability/latest.json",
);

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function exactKeys(value, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isStrictDescendant(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function requireSafeRoot(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw evidenceError();
  return realpathSync(root);
}

function verifyExistingPath(rootRealPath, candidate) {
  if (!existsSync(candidate)) return;
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !isStrictDescendant(rootRealPath, realpathSync(candidate))) {
    throw evidenceError();
  }
}

function verifyExistingAncestors(root, rootRealPath, candidate) {
  let current = root;
  for (const segment of relative(root, candidate).split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    if (!existsSync(current)) return;
    verifyExistingPath(rootRealPath, current);
  }
}

function ensureOwnerDirectory(root, rootRealPath, directory) {
  let current = root;
  for (const segment of relative(root, directory).split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw evidenceError();
    if (process.platform !== "win32") chmodSync(current, 0o700);
    if (!isStrictDescendant(rootRealPath, realpathSync(current))) throw evidenceError();
  }
}

function evidenceLayout(reportPath = DEFAULT_CAPABILITY_REPORT_PATH, allowedRoot) {
  const canonicalReport = resolve(reportPath);
  const root = resolve(allowedRoot ?? dirname(dirname(dirname(dirname(canonicalReport)))));
  if (!isStrictDescendant(root, canonicalReport)) throw evidenceError();
  const rootRealPath = requireSafeRoot(root);
  verifyExistingAncestors(root, rootRealPath, canonicalReport);
  const directory = dirname(canonicalReport);
  return {
    attemptsDirectory: join(directory, "attempts"),
    axisProgressDirectory: join(directory, "axis-progress"),
    canonicalReport,
    directory,
    pointer: join(directory, "latest-attempt.json"),
    root,
    rootRealPath,
  };
}

function attemptPaths(layout, attemptId) {
  if (!UUID.test(attemptId)) throw evidenceError();
  return {
    report: join(layout.attemptsDirectory, `${attemptId}.report.json`),
    state: join(layout.attemptsDirectory, `${attemptId}.state.json`),
  };
}

function syncDirectory(directory, fsync = fsyncSync) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWriteText(layout, target, text, options = {}) {
  if (Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_BYTES) throw evidenceError();
  ensureOwnerDirectory(layout.root, layout.rootRealPath, dirname(target));
  verifyExistingAncestors(layout.root, layout.rootRealPath, target);
  const transaction = `${target}.transaction`;
  const rollback = `${target}.rollback`;
  if (existsSync(transaction) || existsSync(rollback)) throw evidenceError();
  if (existsSync(target)) {
    const targetStat = lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw evidenceError();
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let descriptor;
  let transactionDescriptor;
  let transactionCreated = false;
  let rollbackCreated = false;
  let targetReplaced = false;
  let committed = false;
  const fsync = options.fsync ?? fsyncSync;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, text, "utf8");
    fsync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    verifyExistingAncestors(layout.root, layout.rootRealPath, target);

    transactionDescriptor = openSync(transaction, "wx", 0o600);
    transactionCreated = true;
    writeFileSync(transactionDescriptor, "pending\n", "utf8");
    fsync(transactionDescriptor);
    closeSync(transactionDescriptor);
    transactionDescriptor = undefined;
    syncDirectory(dirname(target), fsync);

    if (existsSync(target)) {
      renameSync(target, rollback);
      rollbackCreated = true;
      syncDirectory(dirname(target), fsync);
    }
    (options.rename ?? renameSync)(temporary, target);
    targetReplaced = true;
    if (process.platform !== "win32") chmodSync(target, 0o600);
    syncDirectory(dirname(target), fsync);

    rmSync(transaction);
    transactionCreated = false;
    committed = true;
    try { syncDirectory(dirname(target), fsync); } catch { /* commit is visible; crash recovery remains fail-closed */ }
    if (rollbackCreated) {
      rmSync(rollback);
      rollbackCreated = false;
      try { syncDirectory(dirname(target), fsync); } catch { /* post-commit cleanup durability */ }
    }
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* fail closed below */ }
    }
    if (transactionDescriptor !== undefined) {
      try { closeSync(transactionDescriptor); } catch { /* fail closed below */ }
    }
    if (!committed) {
      let restored = false;
      try {
        if (rollbackCreated && existsSync(rollback)) {
          renameSync(rollback, target);
          rollbackCreated = false;
          restored = true;
        } else if (targetReplaced) {
          rmSync(target, { force: true });
          restored = true;
        } else {
          restored = true;
        }
        syncDirectory(dirname(target), fsync);
      } catch {
        // Keep the transaction marker: the shared inspector rejects it.
      }
      if (restored && transactionCreated) {
        try {
          rmSync(transaction);
          transactionCreated = false;
          try { syncDirectory(dirname(target), fsync); } catch { /* restored state is visible */ }
        } catch {
          // A surviving marker keeps the evidence invalid.
        }
      }
    }
    throw evidenceError();
  } finally {
    rmSync(temporary, { force: true });
  }
}

function atomicWriteJson(layout, target, value, options) {
  atomicWriteText(layout, target, canonicalJson(value), options);
}

function readCanonicalJson(layout, path) {
  verifyExistingAncestors(layout.root, layout.rootRealPath, path);
  if (existsSync(`${path}.transaction`) || existsSync(`${path}.rollback`)) return { state: "invalid" };
  if (!existsSync(path)) return { state: "missing" };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES) {
    return { state: "invalid" };
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) return { state: "invalid" };
  if (!isStrictDescendant(layout.rootRealPath, realpathSync(path))) return { state: "invalid" };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    return { state: "invalid" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "invalid" };
  }
  if (canonicalJson(value) !== text) return { state: "invalid" };
  return { digest: sha256(text), state: "ok", text, value };
}

function parsePointer(value) {
  if (!exactKeys(value, ["attemptId", "schemaVersion"])) return undefined;
  if (value.schemaVersion !== CAPABILITY_EVIDENCE_SCHEMA_VERSION || !UUID.test(value.attemptId)) return undefined;
  return value;
}

function parseAttemptState(value, attemptId) {
  if (!value || value.attemptId !== attemptId || value.schemaVersion !== CAPABILITY_EVIDENCE_SCHEMA_VERSION) return undefined;
  if (value.phase === "running") {
    return exactKeys(value, ["attemptId", "phase", "schemaVersion"]) ? value : undefined;
  }
  if (value.phase !== "completed" || !SHA256.test(value.reportSha256)) return undefined;
  if (value.status === "passed") {
    if (!exactKeys(value, ["attemptId", "canonicalSha256", "phase", "reportSha256", "schemaVersion", "status"])) return undefined;
    if (!SHA256.test(value.canonicalSha256) || value.canonicalSha256 !== value.reportSha256) return undefined;
    return value;
  }
  if (value.status !== "failed" && value.status !== "unverified") return undefined;
  return exactKeys(value, ["attemptId", "phase", "reportSha256", "schemaVersion", "status"])
    ? value
    : undefined;
}

function isV2ReportWithStatus(value, status) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.version === 2
    && value.status === status;
}

function sourceSnapshotIsClean(value) {
  return exactKeys(value, ["revision", "tree"])
    && value.tree === "clean"
    && SOURCE_REVISION.test(value.revision);
}

function artifactSnapshotIsStable(left, right) {
  return exactKeys(left, ["count", "digest", "status"])
    && exactKeys(right, ["count", "digest", "status"])
    && left.status === "ok"
    && right.status === "ok"
    && Number.isSafeInteger(left.count)
    && left.count > 0
    && right.count === left.count
    && SHA256.test(left.digest)
    && right.digest === left.digest;
}

function capabilityReportShapeIsExact(report) {
  if (!exactKeys(report, ["capabilities", "counts", "generatedAt", "matrixId", "provenance", "status", "version"])) return false;
  if (report.version !== 2 || report.matrixId !== CAPABILITY_MATRIX_ID || !Array.isArray(report.capabilities)) return false;
  const generatedAt = typeof report.generatedAt === "string" ? Date.parse(report.generatedAt) : Number.NaN;
  if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== report.generatedAt) return false;
  if (report.capabilities.length !== CAPABILITY_MATRIX.length) return false;
  for (let index = 0; index < CAPABILITY_MATRIX.length; index += 1) {
    const expected = CAPABILITY_MATRIX[index];
    const row = report.capabilities[index];
    const keys = row?.reason === undefined
      ? ["durationMs", "executed", "id", "requested", "required", "status"]
      : ["durationMs", "executed", "id", "reason", "requested", "required", "status"];
    if (!exactKeys(row, keys) || row.id !== expected.id || row.required !== expected.required || row.requested !== expected.repeats) return false;
    if (!Number.isSafeInteger(row.executed) || row.executed < 0 || row.executed > row.requested) return false;
    if (!Number.isSafeInteger(row.durationMs) || row.durationMs < 0) return false;
    if (row.status !== "passed" && row.status !== "failed" && row.status !== "unverified") return false;
    if (row.status === "passed" && (row.executed !== row.requested || row.reason !== undefined)) return false;
    if (row.status !== "passed" && !CAPABILITY_REPORT_REASON_CODES.has(row.reason)) return false;
  }
  if (!exactKeys(report.counts, ["failed", "passed", "total", "unverified"])) return false;
  const expectedCounts = {
    failed: report.capabilities.filter((row) => row.status === "failed").length,
    passed: report.capabilities.filter((row) => row.status === "passed").length,
    total: report.capabilities.length,
    unverified: report.capabilities.filter((row) => row.status === "unverified").length,
  };
  if (Object.keys(expectedCounts).some((key) => report.counts[key] !== expectedCounts[key])) return false;
  const expectedStatus = expectedCounts.failed > 0
    ? "failed"
    : report.capabilities.some((row) => row.required && row.status !== "passed") ? "unverified" : "passed";
  return report.status === expectedStatus;
}

export function isCanonicalPassingCapabilityReport(report) {
  if (!capabilityReportShapeIsExact(report) || report.status !== "passed") return false;
  if (!exactKeys(report.provenance, ["artifactsAfterBuild", "artifactsAtEnd", "sourceAfterBuild", "sourceAtEnd", "sourceBeforeBuild"])) return false;
  const source = report.provenance;
  if (!sourceSnapshotIsClean(source.sourceBeforeBuild)
    || !sourceSnapshotIsClean(source.sourceAfterBuild)
    || !sourceSnapshotIsClean(source.sourceAtEnd)) return false;
  const revision = source.sourceBeforeBuild.revision;
  if (source.sourceAfterBuild.revision !== revision || source.sourceAtEnd.revision !== revision) return false;
  return artifactSnapshotIsStable(source.artifactsAfterBuild, source.artifactsAtEnd);
}

export function createCapabilityAxisProgress(report) {
  if (!capabilityReportShapeIsExact(report) || !canonicalCapabilityProvenance(report.provenance)) {
    return undefined;
  }
  const selected = report.capabilities.filter((row) => !isExactNotSelectedRow(row));
  if (selected.length !== 1 || selected[0].reason === "not-selected") return undefined;
  return {
    schemaVersion: CAPABILITY_AXIS_PROGRESS_SCHEMA_VERSION,
    matrixId: CAPABILITY_MATRIX_ID,
    generatedAt: report.generatedAt,
    axis: { ...selected[0] },
    provenance: structuredClone(report.provenance),
  };
}

function isExactNotSelectedRow(row) {
  return row.status === "unverified"
    && row.reason === "not-selected"
    && row.executed === 0
    && row.durationMs === 0;
}

export function composeCapabilityAxisProgress(currentReport, priorProgress = []) {
  const current = createCapabilityAxisProgress(currentReport);
  if (!current || !Array.isArray(priorProgress)) return undefined;
  const currentTime = Date.parse(current.generatedAt);
  const matching = [];
  for (const progress of priorProgress) {
    if (!isCapabilityAxisProgress(progress)) return undefined;
    if (!sameCapabilityProvenance(progress.provenance, current.provenance)) continue;
    const progressTime = Date.parse(progress.generatedAt);
    if (progressTime > currentTime) return undefined;
    matching.push(structuredClone(progress));
  }
  matching.push(current);
  matching.sort((left, right) => Date.parse(left.generatedAt) - Date.parse(right.generatedAt));

  const latestByAxis = new Map();
  for (const progress of matching) {
    const prior = latestByAxis.get(progress.axis.id);
    if (prior && prior.generatedAt === progress.generatedAt) {
      if (canonicalJson(prior) !== canonicalJson(progress)) return undefined;
      continue;
    }
    latestByAxis.set(progress.axis.id, progress);
  }

  const capabilities = CAPABILITY_MATRIX.map((expected, index) => (
    latestByAxis.get(expected.id)?.axis ?? currentReport.capabilities[index]
  ));
  const counts = {
    failed: capabilities.filter((row) => row.status === "failed").length,
    passed: capabilities.filter((row) => row.status === "passed").length,
    total: capabilities.length,
    unverified: capabilities.filter((row) => row.status === "unverified").length,
  };
  const status = counts.failed > 0
    ? "failed"
    : capabilities.some((row) => row.required && row.status !== "passed")
      ? "unverified"
      : "passed";
  const aggregate = {
    version: 2,
    matrixId: CAPABILITY_MATRIX_ID,
    generatedAt: matching[0].generatedAt,
    status,
    counts,
    capabilities: capabilities.map((row) => ({ ...row })),
    provenance: structuredClone(current.provenance),
  };
  return capabilityReportShapeIsExact(aggregate) ? aggregate : undefined;
}

function isCapabilityAxisProgress(value) {
  if (!exactKeys(value, ["axis", "generatedAt", "matrixId", "provenance", "schemaVersion"])) return false;
  if (
    value.schemaVersion !== CAPABILITY_AXIS_PROGRESS_SCHEMA_VERSION
    || value.matrixId !== CAPABILITY_MATRIX_ID
    || !canonicalCapabilityProvenance(value.provenance)
  ) {
    return false;
  }
  const generatedAt = typeof value.generatedAt === "string" ? Date.parse(value.generatedAt) : Number.NaN;
  if (!Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== value.generatedAt) return false;
  const expected = CAPABILITY_MATRIX.find((capability) => capability.id === value.axis?.id);
  if (!expected) return false;
  if (value.axis.reason === "not-selected") return false;
  const report = {
    version: 2,
    matrixId: CAPABILITY_MATRIX_ID,
    generatedAt: value.generatedAt,
    status: value.axis.status === "failed" ? "failed" : "unverified",
    counts: {
      failed: value.axis.status === "failed" ? 1 : 0,
      passed: value.axis.status === "passed" ? 1 : 0,
      total: CAPABILITY_MATRIX.length,
      unverified: value.axis.status === "failed" ? 10 : value.axis.status === "passed" ? 10 : 11,
    },
    capabilities: CAPABILITY_MATRIX.map((capability) => capability.id === expected.id
      ? value.axis
      : {
        durationMs: 0,
        executed: 0,
        id: capability.id,
        reason: "not-selected",
        requested: capability.repeats,
        required: capability.required,
        status: "unverified",
      }),
    provenance: value.provenance,
  };
  return capabilityReportShapeIsExact(report);
}

function canonicalCapabilityProvenance(provenance) {
  if (!exactKeys(provenance, ["artifactsAfterBuild", "artifactsAtEnd", "sourceAfterBuild", "sourceAtEnd", "sourceBeforeBuild"])) {
    return false;
  }
  if (
    !sourceSnapshotIsClean(provenance.sourceBeforeBuild)
    || !sourceSnapshotIsClean(provenance.sourceAfterBuild)
    || !sourceSnapshotIsClean(provenance.sourceAtEnd)
  ) {
    return false;
  }
  const revision = provenance.sourceBeforeBuild.revision;
  return provenance.sourceAfterBuild.revision === revision
    && provenance.sourceAtEnd.revision === revision
    && artifactSnapshotIsStable(provenance.artifactsAfterBuild, provenance.artifactsAtEnd);
}

function sameCapabilityProvenance(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function axisProgressPath(layout, axisId) {
  if (!CAPABILITY_MATRIX.some((capability) => capability.id === axisId)) throw evidenceError();
  return join(layout.axisProgressDirectory, `${axisId}.json`);
}

function parseAxisProgressRecord(value) {
  if (!exactKeys(value, ["attemptId", "progress", "reportSha256", "schemaVersion"])) return undefined;
  if (
    value.schemaVersion !== CAPABILITY_AXIS_PROGRESS_SCHEMA_VERSION
    || !UUID.test(value.attemptId)
    || !SHA256.test(value.reportSha256)
    || !isCapabilityAxisProgress(value.progress)
  ) {
    return undefined;
  }
  return value;
}

function inspectAxisProgressRecord(layout, record) {
  const paths = attemptPaths(layout, record.attemptId);
  const stateRead = readCanonicalJson(layout, paths.state);
  const state = stateRead.state === "ok" ? parseAttemptState(stateRead.value, record.attemptId) : undefined;
  if (state?.phase === "running") return { state: "pending" };
  if (!state || state.phase !== "completed" || state.reportSha256 !== record.reportSha256) {
    return { state: "invalid" };
  }
  const reportRead = readCanonicalJson(layout, paths.report);
  if (
    reportRead.state !== "ok"
    || reportRead.digest !== record.reportSha256
    || !isV2ReportWithStatus(reportRead.value, state.status)
    || !capabilityReportShapeIsExact(reportRead.value)
  ) {
    return { state: "invalid" };
  }
  const row = reportRead.value.capabilities.find((candidate) => candidate.id === record.progress.axis.id);
  if (
    canonicalJson(row) !== canonicalJson(record.progress.axis)
    || !sameCapabilityProvenance(reportRead.value.provenance, record.progress.provenance)
  ) {
    return { state: "invalid" };
  }
  return { progress: record.progress, state: "valid" };
}

function readCapabilityAxisProgress(layout) {
  if (existsSync(layout.axisProgressDirectory)) {
    verifyExistingPath(layout.rootRealPath, layout.axisProgressDirectory);
    const directoryStat = lstatSync(layout.axisProgressDirectory);
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)
    ) {
      throw evidenceError();
    }
    const allowedNames = new Set(CAPABILITY_MATRIX.map((capability) => `${capability.id}.json`));
    if (readdirSync(layout.axisProgressDirectory).some((name) => !allowedNames.has(name))) {
      throw evidenceError();
    }
  }
  const progress = [];
  for (const capability of CAPABILITY_MATRIX) {
    const read = readCanonicalJson(layout, axisProgressPath(layout, capability.id));
    if (read.state === "missing") continue;
    if (read.state !== "ok") throw evidenceError();
    const record = parseAxisProgressRecord(read.value);
    if (!record) throw evidenceError();
    const inspected = inspectAxisProgressRecord(layout, record);
    if (inspected.state === "invalid") throw evidenceError();
    if (inspected.state === "valid") progress.push(inspected.progress);
  }
  return progress;
}

export function beginCapabilityEvidenceAttempt(options = {}) {
  const layout = evidenceLayout(options.reportPath, options.allowedRoot);
  const attemptId = options.attemptId ?? randomUUID();
  const paths = attemptPaths(layout, attemptId);
  const state = { schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION, attemptId, phase: "running" };
  const pointer = { schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION, attemptId };
  atomicWriteJson(layout, paths.state, state, options);
  atomicWriteJson(layout, layout.pointer, pointer, options);
  return { attemptId, reportPath: layout.canonicalReport, allowedRoot: layout.root };
}

export function finalizeCapabilityEvidenceAttempt(attempt, report, options = {}) {
  const layout = evidenceLayout(attempt?.reportPath, attempt?.allowedRoot);
  const paths = attemptPaths(layout, attempt?.attemptId);
  const pointerRead = readCanonicalJson(layout, layout.pointer);
  const pointer = pointerRead.state === "ok" ? parsePointer(pointerRead.value) : undefined;
  if (!pointer || pointer.attemptId !== attempt.attemptId) throw evidenceError();
  if (!capabilityReportShapeIsExact(report)) {
    throw evidenceError();
  }
  const currentProgress = createCapabilityAxisProgress(report);
  const finalizedReport = currentProgress
    ? composeCapabilityAxisProgress(report, readCapabilityAxisProgress(layout))
    : report;
  if (!finalizedReport || !capabilityReportShapeIsExact(finalizedReport)) throw evidenceError();
  const reportText = canonicalJson(finalizedReport);
  const reportSha256 = sha256(reportText);
  atomicWriteText(layout, paths.report, reportText, options);

  if (currentProgress) {
    const latestPointer = readCanonicalJson(layout, layout.pointer);
    const latest = latestPointer.state === "ok" ? parsePointer(latestPointer.value) : undefined;
    if (!latest || latest.attemptId !== attempt.attemptId) throw evidenceError();
    atomicWriteJson(layout, axisProgressPath(layout, currentProgress.axis.id), {
      schemaVersion: CAPABILITY_AXIS_PROGRESS_SCHEMA_VERSION,
      attemptId: attempt.attemptId,
      reportSha256,
      progress: currentProgress,
    }, options);
  }

  if (finalizedReport.status === "passed") {
    if (!isCanonicalPassingCapabilityReport(finalizedReport)) throw evidenceError();
    const latestPointer = readCanonicalJson(layout, layout.pointer);
    const latest = latestPointer.state === "ok" ? parsePointer(latestPointer.value) : undefined;
    if (!latest || latest.attemptId !== attempt.attemptId) throw evidenceError();
    atomicWriteText(layout, layout.canonicalReport, reportText, options);
    atomicWriteJson(layout, paths.state, {
      schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
      attemptId: attempt.attemptId,
      phase: "completed",
      status: "passed",
      reportSha256,
      canonicalSha256: reportSha256,
    }, options);
  } else {
    atomicWriteJson(layout, paths.state, {
      schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
      attemptId: attempt.attemptId,
      phase: "completed",
      status: finalizedReport.status,
      reportSha256,
    }, options);
  }
  return finalizedReport;
}

function legacyArtifact(layout) {
  const canonical = readCanonicalJson(layout, layout.canonicalReport);
  if (canonical.state === "missing") return { state: "missing" };
  if (canonical.state !== "ok") return { state: "invalid" };
  return { state: "parsed", value: canonical.value };
}

export function inspectCapabilityEvidence(options = {}) {
  try {
    const layout = evidenceLayout(options.reportPath, options.allowedRoot);
    const pointerRead = readCanonicalJson(layout, layout.pointer);
    if (pointerRead.state === "missing") return { artifact: legacyArtifact(layout), state: "missing" };
    if (pointerRead.state !== "ok") return { artifact: legacyArtifact(layout), state: "invalid" };
    const pointer = parsePointer(pointerRead.value);
    if (!pointer) return { artifact: legacyArtifact(layout), state: "invalid" };
    const paths = attemptPaths(layout, pointer.attemptId);
    const stateRead = readCanonicalJson(layout, paths.state);
    const state = stateRead.state === "ok" ? parseAttemptState(stateRead.value, pointer.attemptId) : undefined;
    if (!state) return { artifact: legacyArtifact(layout), state: "invalid" };
    if (state.phase === "running") {
      return {
        artifact: legacyArtifact(layout),
        fingerprint: sha256(`${pointerRead.text}${stateRead.text}`),
        state: "running",
      };
    }
    const reportRead = readCanonicalJson(layout, paths.report);
    if (reportRead.state !== "ok" || reportRead.digest !== state.reportSha256
      || !isV2ReportWithStatus(reportRead.value, state.status)) {
      return { artifact: { state: "invalid" }, state: "invalid" };
    }
    let fingerprintInput = `${pointerRead.text}${stateRead.text}${reportRead.text}`;
    if (state.status === "passed") {
      const canonicalRead = readCanonicalJson(layout, layout.canonicalReport);
      if (canonicalRead.state !== "ok" || canonicalRead.digest !== state.canonicalSha256
        || canonicalRead.text !== reportRead.text) {
        return { artifact: { state: "invalid" }, state: "invalid" };
      }
      fingerprintInput += canonicalRead.text;
    }
    return {
      artifact: { state: "parsed", value: reportRead.value },
      fingerprint: sha256(fingerprintInput),
      state: "completed",
      status: state.status,
    };
  } catch {
    return { artifact: { state: "invalid" }, state: "invalid" };
  }
}

function evidenceError() {
  return new Error("capability-report-persistence-failed");
}

function readCliArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes("--inspect")) {
    process.stderr.write("Usage: node scripts/eval-agent-evidence.mjs --inspect --report-path <path> --allowed-root <path>\n");
    process.exitCode = 1;
  } else {
    const reportPath = readCliArg(args, "--report-path");
    const allowedRoot = readCliArg(args, "--allowed-root");
    if (!reportPath || !allowedRoot) {
      process.stdout.write(`${JSON.stringify({ artifact: { state: "invalid" }, state: "invalid" })}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(inspectCapabilityEvidence({ allowedRoot, reportPath }))}\n`);
    }
  }
}
