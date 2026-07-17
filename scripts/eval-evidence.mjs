/**
 * Local-only evidence utilities for Muse agent evals.
 *
 * This module intentionally consumes the privacy-safe P0 JSONL schema, never
 * the trace files referenced by it. A trace ref is an opaque local pointer for
 * a human reviewer, not permission for this code to read the trace.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/iu;
const SAFE_TRACE_REF_RE = /^[a-z0-9][a-z0-9._/-]{0,255}$/iu;
const TERMINAL_STATUSES = new Set(["pass", "fail", "excluded"]);
const INFRA_FAILURE_KINDS = new Set(["infra-null", "infra-timeout"]);
const SAFETY_CRITICAL_MIN_REPEAT = 3;
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(`invalid eval artifact: ${message}`);
}

function compareUnicodeCodePoints(left, right) {
  const a = [...left].map((character) => character.codePointAt(0));
  const b = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON accepts only finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("canonical JSON does not accept cycles");
    seen.add(value);
    const result = value.map((entry) => canonicalValue(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("canonical JSON accepts only JSON objects, arrays, and scalars");
  }
  if (seen.has(value)) throw new TypeError("canonical JSON does not accept cycles");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort(compareUnicodeCodePoints)) {
    if (value[key] === undefined) throw new TypeError("canonical JSON does not accept undefined");
    result[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value, new Set()));
}

function digest(domain, value) {
  return createHash("sha256").update(`${domain}\0${canonicalJson(value)}`).digest("hex");
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("record must be an object");
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  for (const key of actual) if (!allowed.has(key)) fail(`unknown field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`missing field ${key}`);
}

function safeId(value, field) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) fail(`${field} is not a safe ID`);
  return value;
}

function safeInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${field} is not a safe integer >= ${minimum.toString()}`);
  return value;
}

function validateConfig(config) {
  exactKeys(config, ["infraRetries", "minRepeat", "repeat", "safetyCritical", "threshold"]);
  safeInteger(config.infraRetries, "config.infraRetries");
  safeInteger(config.minRepeat, "config.minRepeat");
  safeInteger(config.repeat, "config.repeat", 1);
  if (typeof config.safetyCritical !== "boolean") fail("config.safetyCritical must be boolean");
  if (typeof config.threshold !== "number" || !Number.isFinite(config.threshold) || config.threshold < 0 || config.threshold > 1) {
    fail("config.threshold must be between 0 and 1");
  }
}

function validateTraceRefs(traceRefs) {
  if (!Array.isArray(traceRefs)) fail("traceRefs must be an array");
  for (const ref of traceRefs) {
    if (typeof ref !== "string" || !SAFE_TRACE_REF_RE.test(ref) || ref.split("/").includes("..")) {
      fail("traceRefs must contain opaque relative refs");
    }
  }
}

function validateTrial(record) {
  exactKeys(record, [
    "attemptIndex", "caseId", "config", "repeatIndex", "result", "scenarioId", "schema", "suiteId", "traceRefs",
  ]);
  if (record.schema !== "muse.eval.trial/v1") fail("unexpected trial schema");
  safeInteger(record.attemptIndex, "attemptIndex");
  safeInteger(record.repeatIndex, "repeatIndex");
  safeId(record.suiteId, "suiteId");
  safeId(record.scenarioId, "scenarioId");
  safeId(record.caseId, "caseId");
  validateConfig(record.config);
  validateTraceRefs(record.traceRefs);
  exactKeys(record.result, ["cleanupFailure", "retryScheduled", "status"], ["contaminationMarker", "failureKind"]);
  if (typeof record.result.cleanupFailure !== "boolean" || typeof record.result.retryScheduled !== "boolean") {
    fail("trial result flags must be boolean");
  }
  if (record.result.status !== "retry" && !TERMINAL_STATUSES.has(record.result.status)) fail("unknown trial status");
  if ((record.result.status === "retry") !== record.result.retryScheduled) fail("retry status and retryScheduled disagree");
  for (const field of ["contaminationMarker", "failureKind"]) {
    if (record.result[field] !== undefined) safeId(record.result[field], `result.${field}`);
  }
  const { cleanupFailure, contaminationMarker, failureKind, status } = record.result;
  if (cleanupFailure && status !== "fail") fail("cleanup failure must produce a fail status");
  if (status === "pass" && (failureKind !== undefined || contaminationMarker !== undefined)) {
    fail("pass result cannot carry failureKind or contaminationMarker");
  }
  if (status === "retry" && (!INFRA_FAILURE_KINDS.has(failureKind) || contaminationMarker !== undefined)) {
    fail("retry requires an infra failureKind and no contaminationMarker");
  }
  if (status === "excluded" && (failureKind !== "tier0-contamination" || contaminationMarker === undefined)) {
    fail("excluded result requires a Tier-0 contaminationMarker");
  }
  if (status === "fail" && failureKind === undefined) fail("fail result requires failureKind");
  if (contaminationMarker !== undefined) {
    if (failureKind !== "tier0-contamination") fail("contaminationMarker requires tier0-contamination failureKind");
    if (status === "fail" && !cleanupFailure) fail("Tier-0 contamination may fail only after cleanup failure");
  } else if (failureKind === "tier0-contamination") {
    fail("tier0-contamination failureKind requires contaminationMarker");
  }
}

function validateSummary(summary) {
  exactKeys(summary, ["artifact", "counts", "result", "schema", "suiteId"]);
  if (summary.schema !== "muse.eval.summary/v1") fail("last record must be muse.eval.summary/v1");
  safeId(summary.suiteId, "summary.suiteId");
  exactKeys(summary.artifact, ["errors", "path"]);
  safeInteger(summary.artifact.errors, "summary.artifact.errors");
  if (summary.artifact.errors !== 0 || summary.artifact.path !== "results.jsonl") fail("artifact is incomplete");
  exactKeys(summary.counts, ["executedAttempts", "skippedCases", "trialRecords"]);
  safeInteger(summary.counts.executedAttempts, "counts.executedAttempts");
  safeInteger(summary.counts.skippedCases, "counts.skippedCases");
  safeInteger(summary.counts.trialRecords, "counts.trialRecords");
  exactKeys(summary.result, ["excluded", "flakeRetries", "passed", "rate", "safetyFloorViolations", "total"]);
  safeInteger(summary.result.excluded, "result.excluded");
  safeInteger(summary.result.flakeRetries, "result.flakeRetries");
  safeInteger(summary.result.passed, "result.passed");
  safeInteger(summary.result.total, "result.total");
  if (typeof summary.result.rate !== "number" || !Number.isFinite(summary.result.rate)) fail("result.rate must be finite");
  if (!Array.isArray(summary.result.safetyFloorViolations)) fail("safetyFloorViolations must be an array");
  canonicalJson(summary.result.safetyFloorViolations);
}

function caseKeyOf(record) {
  return `${record.suiteId}/${record.scenarioId}/${record.caseId}`;
}

export function validateEvalArtifact(records) {
  if (!Array.isArray(records) || records.length === 0) fail("records must end in one summary");
  const summary = records.at(-1);
  validateSummary(summary);
  const trials = records.slice(0, -1);
  if (trials.some((record) => record?.schema === "muse.eval.summary/v1")) fail("summary must be unique and last");
  for (const record of trials) validateTrial(record);
  if (summary.counts.executedAttempts !== trials.length || summary.counts.trialRecords !== trials.length) {
    fail("summary trial counts do not match records");
  }
  if (trials.some((record) => record.suiteId !== summary.suiteId)) fail("suiteId does not match summary");

  const identities = new Set();
  const groupedCases = new Map();
  let threshold;
  let retryRecords = 0;
  for (const record of trials) {
    const identity = `${caseKeyOf(record)}/${record.repeatIndex.toString()}/${record.attemptIndex.toString()}`;
    if (identities.has(identity)) fail("duplicate composite attempt identity");
    identities.add(identity);
    if (record.result.status === "retry") retryRecords += 1;
    if (threshold === undefined) threshold = record.config.threshold;
    else if (threshold !== record.config.threshold) fail("suite threshold must be consistent");
    const key = caseKeyOf(record);
    const group = groupedCases.get(key) ?? { config: record.config, records: [], repeats: new Map() };
    if (canonicalJson(group.config) !== canonicalJson(record.config)) fail("case config must be consistent");
    group.records.push(record);
    const repeatRecords = group.repeats.get(record.repeatIndex) ?? [];
    repeatRecords.push(record);
    group.repeats.set(record.repeatIndex, repeatRecords);
    groupedCases.set(key, group);
  }
  if (summary.result.flakeRetries !== retryRecords) fail("summary flakeRetries does not match retry records");

  const cases = [];
  for (const [key, group] of groupedCases) {
    const repeatIndexes = [...group.repeats.keys()].sort((a, b) => a - b);
    repeatIndexes.forEach((repeatIndex, index) => {
      if (repeatIndex !== index) fail("repeatIndex must start at zero and be contiguous");
    });
    const terminals = [];
    for (const repeatIndex of repeatIndexes) {
      const attempts = group.repeats.get(repeatIndex).sort((a, b) => a.attemptIndex - b.attemptIndex);
      attempts.forEach((attempt, index) => {
        if (attempt.attemptIndex !== index) fail("attemptIndex must start at zero and be contiguous");
        const last = index === attempts.length - 1;
        if (last && !TERMINAL_STATUSES.has(attempt.result.status)) fail("retry chain is truncated");
        if (!last && attempt.result.status !== "retry") fail("terminal status cannot precede another attempt");
      });
      if (attempts.length - 1 > group.config.infraRetries) fail("retry chain exceeds config retry budget");
      terminals.push(attempts.at(-1));
    }
    terminals.slice(0, -1).forEach((terminal) => {
      if (terminal.result.status !== "pass") fail("no repeat may follow a failed or excluded repeat");
    });
    const terminalStatus = terminals.at(-1)?.result.status;
    if (terminalStatus === "pass" && terminals.length !== group.config.repeat) fail("pass case must complete every repeat");
    if (terminals.length > group.config.repeat) fail("case has more repeats than configured");
    cases.push({
      caseId: group.records[0].caseId,
      config: group.config,
      key,
      records: group.records,
      scenarioId: group.records[0].scenarioId,
      status: terminalStatus,
      suiteId: group.records[0].suiteId,
      terminal: terminals.at(-1),
    });
  }

  const excluded = cases.filter((entry) => entry.status === "excluded").length;
  const counted = cases.filter((entry) => entry.status !== "excluded");
  const passed = counted.filter((entry) => entry.status === "pass").length;
  const total = counted.length;
  const rate = total === 0 ? 0 : passed / total;
  if (summary.result.excluded !== excluded || summary.result.passed !== passed || summary.result.total !== total || summary.result.rate !== rate) {
    fail("summary result does not match terminal case states");
  }
  const expectedSafetyFloorViolations = [];
  const scenarios = new Map();
  for (const entry of cases) {
    const scenarioKey = `${entry.suiteId}/${entry.scenarioId}`;
    const scenario = scenarios.get(scenarioKey) ?? { cases: [], config: entry.config, scenarioId: entry.scenarioId };
    if (canonicalJson(scenario.config) !== canonicalJson(entry.config)) fail("scenario config must be consistent");
    scenario.cases.push(entry);
    scenarios.set(scenarioKey, scenario);
  }
  for (const scenario of scenarios.values()) {
    if (!scenario.config.safetyCritical) continue;
    const requiredRepeat = Math.max(SAFETY_CRITICAL_MIN_REPEAT, scenario.config.minRepeat);
    if (scenario.config.repeat < requiredRepeat) {
      expectedSafetyFloorViolations.push({
        actualRepeat: scenario.config.repeat,
        kind: "repeat-floor",
        requiredRepeat,
        scenarioId: scenario.scenarioId,
      });
    }
    const countedScenarioCases = scenario.cases.filter((entry) => entry.status !== "excluded");
    const failedCases = countedScenarioCases.filter((entry) => entry.status === "fail").length;
    if (failedCases > 0) {
      expectedSafetyFloorViolations.push({
        failedCases,
        kind: "case-failure",
        scenarioId: scenario.scenarioId,
        totalCases: countedScenarioCases.length,
      });
    }
  }
  if (canonicalJson(summary.result.safetyFloorViolations) !== canonicalJson(expectedSafetyFloorViolations)) {
    fail("summary safety floor violations do not match trial evidence");
  }
  const semanticGate = total > 0
    && threshold !== undefined
    && rate >= threshold
    && summary.result.safetyFloorViolations.length === 0;
  return {
    cases: cases.sort((left, right) => left.key.localeCompare(right.key)),
    records,
    semanticGate,
    sourceArtifactFingerprint: digest("muse.eval.artifact-source/v1", records),
    suiteId: summary.suiteId,
  };
}

export function collectFailedTrialCandidates(records) {
  const artifact = validateEvalArtifact(records);
  return artifact.cases
    .filter((entry) => entry.status === "fail")
    .map((entry) => {
      const core = {
        caseId: entry.caseId,
        config: entry.config,
        failedRepeatIndexes: [entry.terminal.repeatIndex],
        failureKinds: entry.terminal.result.failureKind ? [entry.terminal.result.failureKind] : [],
        scenarioId: entry.scenarioId,
        schema: "muse.eval.case-candidate/v1",
        sourceArtifactFingerprint: artifact.sourceArtifactFingerprint,
        suiteId: entry.suiteId,
        traceRefs: [...new Set(entry.records.flatMap((record) => record.traceRefs))].sort(compareUnicodeCodePoints),
      };
      return {
        ...core,
        candidateKey: digest("muse.eval.candidate-key/v1", core),
      };
    });
}

function validateCandidate(candidate) {
  exactKeys(candidate, [
    "candidateKey", "caseId", "config", "failedRepeatIndexes", "failureKinds", "scenarioId", "schema",
    "sourceArtifactFingerprint", "suiteId", "traceRefs",
  ]);
  if (candidate.schema !== "muse.eval.case-candidate/v1") throw new Error("invalid candidate schema");
  safeId(candidate.suiteId, "candidate.suiteId");
  safeId(candidate.scenarioId, "candidate.scenarioId");
  safeId(candidate.caseId, "candidate.caseId");
  validateConfig(candidate.config);
  if (!/^[a-f0-9]{64}$/u.test(candidate.sourceArtifactFingerprint)) throw new Error("invalid candidate artifact fingerprint");
  if (!Array.isArray(candidate.failedRepeatIndexes) || candidate.failedRepeatIndexes.length === 0) {
    throw new Error("invalid candidate failed repeats");
  }
  candidate.failedRepeatIndexes.forEach((value) => safeInteger(value, "candidate.failedRepeatIndexes"));
  if (!Array.isArray(candidate.failureKinds)) throw new Error("invalid candidate failure kinds");
  candidate.failureKinds.forEach((value) => safeId(value, "candidate.failureKinds"));
  validateTraceRefs(candidate.traceRefs);
  const { candidateKey, ...core } = candidate;
  const expectedKey = digest("muse.eval.candidate-key/v1", core);
  if (candidateKey !== expectedKey) throw new Error("candidate key does not bind the candidate payload");
}

function validateReviewedCase(review) {
  exactKeys(review, ["case", "decision", "redactionConfirmed", "schema", "sourceCandidateKey"]);
  if (review.schema !== "muse.eval.case-review/v1") throw new Error("invalid case review schema");
  if (review.decision !== "promote") throw new Error("case review decision must be promote");
  if (review.redactionConfirmed !== true) throw new Error("case review must explicitly confirm redaction");
  if (typeof review.sourceCandidateKey !== "string") throw new Error("case review candidate key is required");
  exactKeys(review.case, ["expected", "id", "input", "scenarioId", "tags", "title"]);
  safeId(review.case.id, "review.case.id");
  safeId(review.case.scenarioId, "review.case.scenarioId");
  if (typeof review.case.title !== "string" || review.case.title.trim().length === 0 || review.case.title.length > 200) {
    throw new Error("review.case.title must be 1..200 characters");
  }
  if (!Array.isArray(review.case.tags) || review.case.tags.length > 32) throw new Error("review.case.tags must be an array");
  review.case.tags.forEach((tag) => safeId(tag, "review.case.tags"));
  const payloadBytes = Buffer.byteLength(canonicalJson({ expected: review.case.expected, input: review.case.input }), "utf8");
  if (payloadBytes > 32 * 1024) throw new Error("reviewed redacted case payload exceeds 32 KiB");
}

export function promoteReviewedCase(candidate, review) {
  validateCandidate(candidate);
  validateReviewedCase(review);
  if (review.sourceCandidateKey !== candidate.candidateKey) throw new Error("case review does not match this candidate");
  const core = {
    expected: JSON.parse(canonicalJson(review.case.expected)),
    id: review.case.id,
    input: JSON.parse(canonicalJson(review.case.input)),
    scenarioId: review.case.scenarioId,
    schema: "muse.eval.case/v1",
    tags: [...review.case.tags],
    title: review.case.title.trim(),
  };
  const forbiddenLocalValues = new Set([
    candidate.candidateKey,
    candidate.caseId,
    candidate.scenarioId,
    candidate.sourceArtifactFingerprint,
    candidate.suiteId,
    ...candidate.traceRefs,
  ]);
  const serializedCore = canonicalJson(core);
  if ([...forbiddenLocalValues].some((value) => serializedCore.includes(value))) {
    throw new Error("reviewed case still contains a local candidate identifier");
  }
  return {
    ...core,
    sourceFingerprint: digest("muse.eval.case-source/v1", { candidate, case: core }),
  };
}

function classifyDelta(baselineStatus, currentStatus) {
  if (currentStatus === undefined || currentStatus === "excluded") return "unverified";
  if (baselineStatus === undefined) return "new";
  if (baselineStatus === "excluded") return currentStatus === "pass" ? "improved" : "regressed";
  if (baselineStatus === currentStatus) return "unchanged";
  if (baselineStatus === "fail" && currentStatus === "pass") return "improved";
  if (baselineStatus === "pass" && currentStatus === "fail") return "regressed";
  throw new Error("unreachable eval delta state");
}

export function compareEvalArtifacts(baselineRecords, currentRecords) {
  const baseline = validateEvalArtifact(baselineRecords);
  const current = validateEvalArtifact(currentRecords);
  const baselineByKey = new Map(baseline.cases.map((entry) => [entry.key, entry]));
  const currentByKey = new Map(current.cases.map((entry) => [entry.key, entry]));
  const keys = [...new Set([...baselineByKey.keys(), ...currentByKey.keys()])].sort(compareUnicodeCodePoints);
  const cases = keys.map((key) => {
    const before = baselineByKey.get(key);
    const after = currentByKey.get(key);
    const baselineStatus = before?.status;
    const currentStatus = after?.status;
    const identity = before ?? after;
    return {
      baselineStatus: baselineStatus ?? "missing",
      caseId: identity.caseId,
      classification: classifyDelta(baselineStatus, currentStatus),
      currentStatus: currentStatus ?? "missing",
      scenarioId: identity.scenarioId,
      suiteId: identity.suiteId,
    };
  });
  const counts = Object.fromEntries(
    ["improved", "regressed", "unchanged", "new", "unverified"]
      .map((classification) => [classification, cases.filter((entry) => entry.classification === classification).length]),
  );
  const gate = current.semanticGate
    && cases.every((entry) => entry.currentStatus !== "fail"
      && entry.classification !== "regressed"
      && entry.classification !== "unverified");
  return {
    baselineArtifactFingerprint: baseline.sourceArtifactFingerprint,
    baselineSemanticGate: baseline.semanticGate,
    cases,
    counts,
    currentArtifactFingerprint: current.sourceArtifactFingerprint,
    currentSemanticGate: current.semanticGate,
    gate,
    schema: "muse.eval.delta/v1",
  };
}

function parseJsonl(text, label) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    throw new Error(`${label} is not valid JSONL`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function commandFlags(args, command, allowed) {
  if (args[0] !== command) throw new Error(`expected eval evidence command ${command}`);
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid ${command} arguments`);
    const name = flag.slice(2);
    if (!allowed.includes(name) || Object.hasOwn(values, name)) throw new Error(`unknown or duplicate flag --${name}`);
    values[name] = value;
  }
  for (const name of allowed) if (!values[name]) throw new Error(`missing --${name}`);
  return values;
}

async function assertNoSymlinkComponents(directory) {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  let cursor = root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`output path contains symlink component: ${cursor}`);
    if (!metadata.isDirectory()) throw new Error(`output parent component is not a directory: ${cursor}`);
  }
}

async function protectWindowsOwnerOnly(actualPath) {
  const protectOwnerOnlyAcl = [
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent();",
    "$acl = New-Object System.Security.AccessControl.FileSecurity;",
    "$acl.SetOwner($identity.User);",
    "$acl.SetAccessRuleProtection($true, $false);",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $env:MUSE_EVAL_EVIDENCE_PATH -AclObject $acl;",
    "$check = Get-Acl -LiteralPath $env:MUSE_EVAL_EVIDENCE_PATH;",
    "$rules = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]));",
    "if (-not $check.AreAccessRulesProtected -or $rules.Count -eq 0) { exit 21 };",
    "foreach ($entry in $rules) { if ($entry.IdentityReference.Value -ne $identity.User.Value -or $entry.AccessControlType -ne 'Allow') { exit 22 } };",
  ].join(" ");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", protectOwnerOnlyAcl], {
    env: { ...process.env, MUSE_EVAL_EVIDENCE_PATH: actualPath },
    windowsHide: true,
  });
}

async function assertHandleStillNamesOutput(handle, actualPath) {
  const [opened, named] = await Promise.all([
    handle.stat({ bigint: true }),
    stat(actualPath, { bigint: true }),
  ]);
  if (!opened.isFile() || !named.isFile() || opened.ino === 0n || opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new Error("exclusive eval evidence output identity changed during private write");
  }
}

async function writePrivateOutput(outputPath, content, system = {}) {
  const absolute = resolve(outputPath);
  const requestedParent = dirname(absolute);
  await assertNoSymlinkComponents(requestedParent);
  const actualParent = await realpath(requestedParent);
  const actualPath = join(actualParent, basename(absolute));
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  const platform = system.platform ?? process.platform;
  const protectWindowsOutput = system.protectWindowsOutput ?? protectWindowsOwnerOnly;
  let handle;
  let created = false;
  try {
    handle = await open(actualPath, flags, 0o600);
    created = true;
    if (platform === "win32") {
      // Node's Windows chmod cannot express an owner-only ACL. Keep the new
      // file empty until PowerShell has removed inheritance and verified the
      // protected DACL, then prove the still-open handle names that file.
      await protectWindowsOutput(actualPath);
      await assertHandleStillNamesOutput(handle, actualPath);
    } else {
      await handle.chmod(0o600);
    }
    await handle.writeFile(content, "utf8");
    await handle.sync();
    if (platform === "win32") await assertHandleStillNamesOutput(handle, actualPath);
    await handle.close();
    handle = undefined;
    if (platform !== "win32" && ((await stat(actualPath)).mode & 0o777) !== 0o600) {
      throw new Error("exclusive eval evidence output did not retain POSIX mode 0600");
    }
    return actualPath;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(actualPath).catch(() => {});
    throw error;
  }
}

async function readLimitedText(path, readText) {
  const text = await readText(path);
  if (typeof text !== "string") throw new TypeError("eval evidence input reader must return text");
  if (Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) throw new Error("eval evidence input exceeds 16 MiB");
  return text;
}

export async function runEvalEvidenceCli(args, io = {}) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const readText = io.readText ?? ((path) => readFile(path, "utf8"));
  const writeOutput = io.writeOutput ?? ((path, content) => writePrivateOutput(path, content, io.outputSystem));
  const log = io.log ?? console.log;
  const command = normalizedArgs[0];
  if (command === "candidates") {
    const flags = commandFlags(normalizedArgs, command, ["artifact", "out"]);
    const records = parseJsonl(await readLimitedText(flags.artifact, readText), "artifact");
    const candidates = collectFailedTrialCandidates(records);
    await writeOutput(flags.out, candidates.length === 0 ? "" : `${candidates.map(canonicalJson).join("\n")}\n`);
    log(`eval evidence: wrote ${candidates.length.toString()} failure candidate(s)`);
    return { candidates: candidates.length };
  }
  if (command === "promote") {
    const flags = commandFlags(normalizedArgs, command, ["candidates", "review", "out"]);
    const candidates = parseJsonl(await readLimitedText(flags.candidates, readText), "candidates");
    const review = parseJson(await readLimitedText(flags.review, readText), "review");
    if (!review || typeof review !== "object" || typeof review.sourceCandidateKey !== "string") {
      throw new Error("review must name sourceCandidateKey");
    }
    const candidate = candidates.find((entry) => entry?.candidateKey === review.sourceCandidateKey);
    if (!candidate) throw new Error("review candidate was not found in the local candidate file");
    const promoted = promoteReviewedCase(candidate, review);
    await writeOutput(flags.out, `${canonicalJson(promoted)}\n`);
    log("eval evidence: promoted 1 explicitly reviewed redacted case");
    return { promoted: 1 };
  }
  if (command === "compare") {
    const flags = commandFlags(normalizedArgs, command, ["baseline", "current", "out"]);
    const [baselineText, currentText] = await Promise.all([
      readLimitedText(flags.baseline, readText),
      readLimitedText(flags.current, readText),
    ]);
    const report = compareEvalArtifacts(parseJsonl(baselineText, "baseline"), parseJsonl(currentText, "current"));
    await writeOutput(flags.out, `${canonicalJson(report)}\n`);
    log(`eval evidence: delta gate ${report.gate ? "PASS" : "FAIL"}`);
    return report;
  }
  throw new Error("usage: eval-evidence.mjs candidates|promote|compare [explicit paths]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const result = await runEvalEvidenceCli(process.argv.slice(2));
    if (result?.gate === false) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
