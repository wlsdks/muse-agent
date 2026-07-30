#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  RELEASE_FINDING_RULE_IDS,
  releaseEvidenceInputHash,
} from "./eval-release-evidence.mjs";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const VERDICTS = new Set(["false-positive", "owner-review", "remediation-required"]);

export function classifyReleaseFindingSlice({
  candidatePath,
  outputPath,
  priorClassificationPath,
  releaseEvidencePath,
  repoRoot = process.cwd(),
  ruleId,
  scope,
  spawn = spawnSync,
  now = () => new Date(),
}) {
  if (!RELEASE_FINDING_RULE_IDS.includes(ruleId) || (scope !== "candidate" && scope !== "source")) {
    throw classificationError();
  }
  const root = requireSafeRoot(resolve(repoRoot));
  const candidate = requireSafeInput(root, candidatePath);
  const releasePath = requireSafeInput(root, releaseEvidencePath);
  const priorPath = requireSafeInput(root, priorClassificationPath);
  const output = requireSafeOutput(root, outputPath, spawn);
  if (output === candidate || output === releasePath || output === priorPath) {
    throw classificationError();
  }

  const candidateBytes = readBoundedRegularFile(candidate, MAX_CANDIDATE_BYTES);
  const releaseRead = readCanonicalJson(releasePath);
  const priorRead = readCanonicalJson(priorPath);
  const release = parseReleaseEvidence(releaseRead.value);
  const prior = parsePriorClassification(priorRead.value, { ruleId, scope });
  const source = captureCurrentSource(root.real, spawn);
  const embeddedCommit = gitTarCommit(candidateBytes, root.real, spawn);
  const embeddedTree = embeddedCommit
    ? gitText(spawn, ["rev-parse", `${embeddedCommit}^{tree}`], root.real)
    : undefined;
  if (
    !source.clean
    || source.head !== source.upstream
    || release.source.head !== source.head
    || release.source.tree !== source.tree
    || !release.source.clean
    || !release.candidate.matchesCurrent
    || release.candidate.commit !== source.head
    || release.candidate.tree !== source.tree
    || release.candidate.byteSize !== candidateBytes.byteLength
    || release.candidate.sha256 !== sha256(candidateBytes)
    || release.candidate.name !== basename(candidate)
    || embeddedCommit !== source.head
    || embeddedTree !== source.tree
  ) {
    throw classificationError();
  }

  const findings = release.findings
    .filter((finding) => finding.ruleId === ruleId && finding.scope === scope)
    .map(stripScope)
    .sort(compareFinding);
  if (findings.length === 0 || findings.length !== prior.findings.length) {
    throw classificationError();
  }
  if (canonicalJson(findings) !== canonicalJson(prior.findings)) throw classificationError();
  const tupleSetHash = sha256(Buffer.from(JSON.stringify(findings), "utf8"));
  if (tupleSetHash !== prior.bijection.tupleSetHash) throw classificationError();
  if (!relevantPathsUnchanged(
    spawn,
    root.real,
    prior.source.head,
    source.head,
    findings.map((finding) => finding.path),
  )) {
    throw classificationError();
  }

  const oppositeScope = scope === "candidate" ? "source" : "candidate";
  const opposite = release.findings
    .filter((finding) => finding.ruleId === ruleId && finding.scope === oppositeScope)
    .map(stripScope);
  const oppositeKeys = new Set(opposite.map(findingKey));
  const findingKeys = new Set(findings.map(findingKey));
  if (
    findingKeys.size !== findings.length
    || oppositeKeys.size !== opposite.length
    || opposite.length !== findings.length
    || findings.some((finding) => !oppositeKeys.has(findingKey(finding)))
  ) {
    throw classificationError();
  }

  const remainingUnclassified = release.findings.length - findings.length;
  const roadmap = requireSafeInput(
    root,
    join(root.lexical, "internal/goals/personal-agent-successor-roadmap.md"),
  );
  const inputHashPreimage = {
    archiveSha256: release.candidate.sha256,
    priorClassificationSha256: priorRead.digest,
    releaseEvidenceSha256: releaseRead.digest,
    roadmapSha256: sha256(readBoundedRegularFile(roadmap, MAX_INPUT_BYTES)),
    slice: `${ruleId}:${scope}`,
    sourceHead: source.head,
    sourceTree: source.tree,
    sourceUpstream: source.upstream,
    sourceWorktree: "clean",
    tupleSetHash,
  };
  const generatedAt = now().toISOString();
  if (new Date(Date.parse(generatedAt)).toISOString() !== generatedAt) throw classificationError();
  const report = {
    schemaVersion: "muse.release-finding-classification/v1",
    taskId: "PA-S003",
    slice: { ruleId, scope, findingCount: findings.length },
    status: "slice-classified",
    generatedAt,
    inputHashAlgorithm: "sha256",
    inputHashContract: "sha256(utf8(JSON.stringify(inputHashPreimage)))",
    inputHashPreimage,
    inputHash: sha256(Buffer.from(JSON.stringify(inputHashPreimage), "utf8")),
    source: {
      head: source.head,
      tree: source.tree,
      upstream: source.upstream,
      worktree: "clean",
    },
    candidate: {
      archiveSha256: release.candidate.sha256,
      commit: release.candidate.commit,
      tree: release.candidate.tree,
      matchesCurrentSource: true,
    },
    bijection: {
      sourceFindingCount: opposite.length,
      candidateFindingCount: findings.length,
      priorSourceFindingCount: prior.bijection.sourceFindingCount,
      exact: true,
      tupleFields: ["path", "line", "ruleId", "matchHash"],
      tupleSetHash,
    },
    findings,
    classification: structuredClone(prior.classification),
    releaseDecision: {
      gate: "red",
      classifiedInThisSlice: findings.length,
      remainingUnclassified,
      reason: remainingUnclassified > 0
        ? "Unclassified findings remain; signing and release gates remain unchanged."
        : "Finding classification does not verify source or candidate signatures.",
    },
    effects: {
      credentialUse: 0,
      matchedValueOutput: 0,
      network: 0,
      publication: 0,
      release: 0,
      signing: 0,
      tag: 0,
    },
  };
  atomicWriteJson(root.real, output, report);
  return report;
}

function parseReleaseEvidence(value) {
  if (!exactKeys(value, [
    "candidate", "findings", "generatedAt", "inputHash", "inputHashAlgorithm",
    "overall", "reasons", "scans", "signatures", "source", "version",
  ])) throw classificationError();
  if (
    value.version !== 1
    || value.inputHashAlgorithm !== "sha256"
    || !SHA256.test(value.inputHash)
    || !exactIsoTimestamp(value.generatedAt)
    || value.overall !== "red"
    || !Array.isArray(value.reasons)
    || !value.reasons.includes("unclassified-finding")
    || !completeReleaseScans(value.scans)
    || !Array.isArray(value.findings)
    || !exactKeys(value.source, ["clean", "head", "tree"])
    || typeof value.source.clean !== "boolean"
    || !REVISION.test(value.source.head)
    || !REVISION.test(value.source.tree)
    || !exactKeys(value.candidate, [
      "byteSize", "commit", "matchesCurrent", "name", "sha256", "tree",
    ])
    || !Number.isSafeInteger(value.candidate.byteSize)
    || value.candidate.byteSize <= 0
    || !REVISION.test(value.candidate.commit)
    || !REVISION.test(value.candidate.tree)
    || typeof value.candidate.matchesCurrent !== "boolean"
    || !SHA256.test(value.candidate.sha256)
    || value.inputHash !== releaseEvidenceInputHash({
      candidateSha256: value.candidate.sha256,
      sourceHead: value.source.head,
      sourceTree: value.source.tree,
    })
  ) {
    throw classificationError();
  }
  for (const finding of value.findings) {
    parseFinding(finding, true);
    if (!RELEASE_FINDING_RULE_IDS.includes(finding.ruleId)) throw classificationError();
  }
  return value;
}

function completeReleaseScans(value) {
  if (!exactKeys(value, ["candidate", "source"])) return false;
  const candidateKeys = [
    "bytes", "duplicateEntries", "entries", "specialEntries", "status", "tool",
  ];
  const sourceKeys = ["bytes", "duplicateEntries", "entries", "specialEntries", "status", "tool"];
  if (!exactKeys(value.candidate, candidateKeys) || !exactKeys(value.source, sourceKeys)) return false;
  for (const scan of [value.candidate, value.source]) {
    if (
      scan.status !== "complete"
      || !Number.isSafeInteger(scan.bytes)
      || scan.bytes <= 0
      || !Number.isSafeInteger(scan.entries)
      || scan.entries <= 0
      || scan.duplicateEntries !== 0
      || scan.specialEntries !== 0
      || typeof scan.tool !== "string"
      || scan.tool.length === 0
    ) return false;
  }
  return value.candidate.tool === "tar" && value.source.tool === "git-ls-files";
}

function parsePriorClassification(value, slice) {
  if (!exactKeys(value, [
    "bijection", "candidate", "classification", "effects", "findings", "generatedAt",
    "inputHash", "inputHashAlgorithm", "inputHashContract", "inputHashPreimage",
    "releaseDecision", "schemaVersion", "slice", "source", "status", "taskId",
  ])) throw classificationError();
  if (
    value.schemaVersion !== "muse.release-finding-classification/v1"
    || value.taskId !== "PA-S003"
    || value.status !== "slice-classified"
    || value.inputHashAlgorithm !== "sha256"
    || value.inputHashContract !== "sha256(utf8(JSON.stringify(inputHashPreimage)))"
    || !SHA256.test(value.inputHash)
    || !exactKeys(value.inputHashPreimage, [
      "archiveSha256", "priorClassificationSha256", "releaseEvidenceSha256",
      "roadmapSha256", "slice", "sourceHead", "sourceTree", "sourceUpstream",
      "sourceWorktree", "tupleSetHash",
    ])
    || !SHA256.test(value.inputHashPreimage.archiveSha256)
    || !SHA256.test(value.inputHashPreimage.priorClassificationSha256)
    || !SHA256.test(value.inputHashPreimage.releaseEvidenceSha256)
    || !SHA256.test(value.inputHashPreimage.roadmapSha256)
    || !SHA256.test(value.inputHashPreimage.tupleSetHash)
    || !REVISION.test(value.inputHashPreimage.sourceHead)
    || !REVISION.test(value.inputHashPreimage.sourceTree)
    || !REVISION.test(value.inputHashPreimage.sourceUpstream)
    || value.inputHashPreimage.sourceWorktree !== "clean"
    || value.inputHash !== sha256(Buffer.from(JSON.stringify(value.inputHashPreimage), "utf8"))
    || !exactIsoTimestamp(value.generatedAt)
    || !exactKeys(value.slice, ["findingCount", "ruleId", "scope"])
    || value.slice.ruleId !== slice.ruleId
    || value.slice.scope !== slice.scope
    || !Number.isSafeInteger(value.slice.findingCount)
    || !Array.isArray(value.findings)
    || value.slice.findingCount !== value.findings.length
    || !exactKeys(value.bijection, [
      "candidateFindingCount", "exact", "priorSourceFindingCount",
      "sourceFindingCount", "tupleFields", "tupleSetHash",
    ])
    || value.bijection.exact !== true
    || !SHA256.test(value.bijection.tupleSetHash)
    || value.bijection.candidateFindingCount !== value.findings.length
    || value.bijection.sourceFindingCount !== value.findings.length
    || value.bijection.priorSourceFindingCount !== value.findings.length
    || canonicalJson(value.bijection.tupleFields) !== canonicalJson(["path", "line", "ruleId", "matchHash"])
    || value.bijection.tupleSetHash !== sha256(Buffer.from(JSON.stringify(value.findings), "utf8"))
    || !exactKeys(value.source, ["head", "tree", "upstream", "worktree"])
    || !REVISION.test(value.source.head)
    || !REVISION.test(value.source.tree)
    || !REVISION.test(value.source.upstream)
    || value.source.worktree !== "clean"
    || value.source.head !== value.source.upstream
    || !exactKeys(value.candidate, ["archiveSha256", "commit", "matchesCurrentSource", "tree"])
    || !SHA256.test(value.candidate.archiveSha256)
    || !REVISION.test(value.candidate.commit)
    || !REVISION.test(value.candidate.tree)
    || value.candidate.matchesCurrentSource !== true
    || value.candidate.commit !== value.source.head
    || value.candidate.tree !== value.source.tree
    || value.inputHashPreimage.archiveSha256 !== value.candidate.archiveSha256
    || value.inputHashPreimage.slice !== `${value.slice.ruleId}:${value.slice.scope}`
    || value.inputHashPreimage.sourceHead !== value.source.head
    || value.inputHashPreimage.sourceTree !== value.source.tree
    || value.inputHashPreimage.sourceUpstream !== value.source.upstream
    || value.inputHashPreimage.sourceHead !== value.inputHashPreimage.sourceUpstream
    || value.inputHashPreimage.tupleSetHash !== value.bijection.tupleSetHash
    || !exactKeys(value.releaseDecision, [
      "classifiedInThisSlice", "gate", "reason", "remainingUnclassified",
    ])
    || value.releaseDecision.gate !== "red"
    || value.releaseDecision.classifiedInThisSlice !== value.findings.length
    || !Number.isSafeInteger(value.releaseDecision.remainingUnclassified)
    || value.releaseDecision.remainingUnclassified < 0
    || typeof value.releaseDecision.reason !== "string"
    || !classificationIsConsistent(value.classification)
    || !zeroEffects(value.effects)
  ) {
    throw classificationError();
  }
  for (const finding of value.findings) parseFinding(finding, false);
  const sorted = [...value.findings].sort(compareFinding);
  if (canonicalJson(value.findings) !== canonicalJson(sorted)) throw classificationError();
  return value;
}

function classificationIsConsistent(value) {
  if (!exactKeys(value, [
    "credentialValidationPerformed", "matchedContentStored", "ownerReviewRequired",
    "reasonCode", "remediationRequired", "verdict",
  ])) return false;
  if (
    !VERDICTS.has(value.verdict)
    || !SAFE_ID.test(value.reasonCode)
    || value.matchedContentStored !== false
    || value.credentialValidationPerformed !== false
  ) return false;
  if (value.verdict === "false-positive") {
    return value.ownerReviewRequired === false && value.remediationRequired === false;
  }
  if (value.verdict === "owner-review") {
    return value.ownerReviewRequired === true && value.remediationRequired === false;
  }
  return value.ownerReviewRequired === false && value.remediationRequired === true;
}

function zeroEffects(value) {
  const keys = ["credentialUse", "matchedValueOutput", "network", "publication", "release", "signing", "tag"];
  return exactKeys(value, keys) && keys.every((key) => value[key] === 0);
}

function parseFinding(value, withScope) {
  const keys = withScope
    ? ["line", "matchHash", "path", "ruleId", "scope"]
    : ["line", "matchHash", "path", "ruleId"];
  if (
    !exactKeys(value, keys)
    || !Number.isSafeInteger(value.line)
    || value.line <= 0
    || !SHA256.test(value.matchHash)
    || !safeRelativePath(value.path)
    || !SAFE_ID.test(value.ruleId)
    || (withScope && value.scope !== "candidate" && value.scope !== "source")
  ) throw classificationError();
  return value;
}

function stripScope({ line, matchHash, path, ruleId }) {
  return { path, line, ruleId, matchHash };
}

function findingKey(value) {
  return JSON.stringify([value.path, value.line, value.ruleId, value.matchHash]);
}

function compareFinding(left, right) {
  return compareText(left.path, right.path)
    || left.line - right.line
    || compareText(left.ruleId, right.ruleId)
    || compareText(left.matchHash, right.matchHash);
}

function relevantPathsUnchanged(spawn, root, priorHead, currentHead, paths) {
  if (priorHead === currentHead) return true;
  const uniquePaths = [...new Set(paths)].sort(compareText);
  if (uniquePaths.length === 0 || uniquePaths.some((path) => !safeRelativePath(path))) return false;
  const ancestry = spawn(
    "git",
    ["merge-base", "--is-ancestor", priorHead, currentHead],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );
  if (ancestry?.status !== 0 || ancestry.signal !== null || ancestry.error) return false;
  const result = spawn(
    "git",
    [
      "--literal-pathspecs",
      "diff",
      "--quiet",
      "--no-ext-diff",
      priorHead,
      currentHead,
      "--",
      ...uniquePaths,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );
  return result?.status === 0 && result.signal === null && !result.error;
}

function captureCurrentSource(root, spawn) {
  const head = gitText(spawn, ["rev-parse", "HEAD"], root);
  const tree = gitText(spawn, ["rev-parse", "HEAD^{tree}"], root);
  const upstream = gitText(spawn, ["rev-parse", "@{upstream}"], root);
  const status = gitText(spawn, ["status", "--porcelain=v1", "--untracked-files=all"], root, true);
  if (!REVISION.test(head) || !REVISION.test(tree) || !REVISION.test(upstream)) {
    throw classificationError();
  }
  return { clean: status.length === 0, head, tree, upstream };
}

function gitTarCommit(bytes, root, spawn) {
  const result = spawn("git", ["get-tar-commit-id"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    input: bytes.subarray(0, Math.min(bytes.byteLength, 1024)),
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
  const value = result?.status === 0 && result.signal === null && !result.error
    ? String(result.stdout).trim()
    : "";
  return REVISION.test(value) ? value : undefined;
}

function gitText(spawn, args, cwd, allowEmpty = false) {
  const result = spawn("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const value = result?.status === 0 && result.signal === null && !result.error
    ? String(result.stdout).trim()
    : "";
  if (!allowEmpty && value.length === 0) throw classificationError();
  return value;
}

function readCanonicalJson(path) {
  const bytes = readBoundedRegularFile(path);
  const text = bytes.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw classificationError();
  }
  if (canonicalJson(value) !== text) throw classificationError();
  return { digest: sha256(bytes), value };
}

function readBoundedRegularFile(path, maximumBytes = MAX_INPUT_BYTES) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) throw classificationError();
    return readFileSync(descriptor);
  } catch {
    throw classificationError();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requireSafeRoot(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw classificationError();
  return { lexical: root, real: realpathSync(root) };
}

function requireSafeInput(root, path) {
  if (typeof path !== "string") throw classificationError();
  const requested = resolve(path);
  if (!isStrictDescendant(root.lexical, requested)) throw classificationError();
  verifyExistingAncestry(root.lexical, requested);
  const stat = lstatSync(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) throw classificationError();
  const candidate = realpathSync(requested);
  if (!isStrictDescendant(root.real, candidate)) throw classificationError();
  return candidate;
}

function requireSafeOutput(root, path, spawn) {
  if (typeof path !== "string") throw classificationError();
  const requested = resolve(path);
  if (!isStrictDescendant(root.lexical, requested)) throw classificationError();
  verifyExistingAncestry(root.lexical, requested);
  const parent = realpathSync(dirname(requested));
  const output = join(parent, basename(requested));
  if (!isStrictDescendant(root.real, output)) throw classificationError();
  const rel = relative(root.real, output);
  const ignored = spawn("git", ["check-ignore", "--quiet", "--no-index", "--", rel], {
    cwd: root.real,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 30_000,
  });
  if (ignored?.status !== 0 || ignored.signal !== null || ignored.error) throw classificationError();
  if (existsSync(output)) {
    const stat = lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw classificationError();
  }
  return output;
}

function verifyExistingAncestry(root, candidate) {
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw classificationError();
  }
}

function ensureOwnerDirectory(root, directory) {
  let current = root;
  for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw classificationError();
    if (process.platform !== "win32") chmodSync(current, 0o700);
    if (!isStrictDescendant(root, realpathSync(current))) throw classificationError();
  }
}

function atomicWriteJson(root, output, value) {
  ensureOwnerDirectory(root, dirname(output));
  verifyExistingAncestry(root, output);
  const text = canonicalJson(value);
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) throw classificationError();
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    if (existsSync(output)) {
      const stat = lstatSync(output);
      if (!stat.isFile() || stat.isSymbolicLink()) throw classificationError();
    }
    renameSync(temporary, output);
    if (process.platform !== "win32") chmodSync(output, 0o600);
  } catch {
    rmSync(temporary, { force: true });
    throw classificationError();
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeRelativePath(path) {
  return typeof path === "string"
    && path.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && !path.includes("\\")
    && !isAbsolute(path)
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isStrictDescendant(root, candidate) {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value === canonical
    || (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function classificationError() {
  return new Error("release-finding-classification-failed");
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    const key = {
      "--package-candidate": "candidatePath",
      "--output": "outputPath",
      "--prior-classification": "priorClassificationPath",
      "--release-evidence": "releaseEvidencePath",
      "--rule-id": "ruleId",
      "--scope": "scope",
    }[flag];
    const value = argv[index + 1];
    if (!key || !value || value.startsWith("--") || values[key] !== undefined) {
      throw classificationError();
    }
    values[key] = value;
    index += 1;
  }
  if (Object.keys(values).length !== 6) throw classificationError();
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = classifyReleaseFindingSlice(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      classified: result.releaseDecision.classifiedInThisSlice,
      gate: result.releaseDecision.gate,
      remainingUnclassified: result.releaseDecision.remainingUnclassified,
      ruleId: result.slice.ruleId,
      scope: result.slice.scope,
      verdict: result.classification.verdict,
    })}\n`);
    process.exitCode = 1;
  } catch {
    process.stderr.write("release finding classification failed\n");
    process.exitCode = 1;
  }
}
