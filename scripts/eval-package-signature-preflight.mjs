#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateReleaseEvidence } from "./eval-release-evidence.mjs";

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function commandOptions(cwd) {
  return {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: MAX_COMMAND_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS
  };
}

function git(repoRoot, args) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], commandOptions(repoRoot));
  if (result.status !== 0 || result.signal !== null || result.error) {
    throw new Error("package signature preflight requires readable local Git state");
  }
  return result.stdout.trim();
}

export function capturePackagePreflightSource(repoRoot) {
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  const upstream = git(repoRoot, ["rev-parse", "@{upstream}"]);
  const dirty = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!REVISION.test(head) || !REVISION.test(tree) || !REVISION.test(upstream)) {
    throw new Error("package signature preflight source identity is invalid");
  }
  return { head, tree, upstream, worktree: dirty.length === 0 ? "clean" : "dirty" };
}

function safeEvidenceOutput(repoRoot, requestedArtifactRoot, requested) {
  if (!requestedArtifactRoot) {
    throw new Error("usage: eval-package-signature-preflight --artifact-root <outside-repo-dir> --output <json>");
  }
  if (!requested) throw new Error("usage: eval-package-signature-preflight --output <ignored-json>");
  const requestedRoot = resolve(repoRoot);
  const root = realpathSync(requestedRoot);
  const artifactRootInput = resolve(
    isAbsolute(requestedArtifactRoot)
      ? requestedArtifactRoot
      : resolve(requestedRoot, requestedArtifactRoot)
  );
  const artifactRootInputStat = lstatSync(artifactRootInput);
  const artifactRoot = realpathSync(artifactRootInput);
  const artifactRootStat = lstatSync(artifactRoot);
  if (
    artifactRoot !== artifactRootInput
    || artifactRootInputStat.dev !== artifactRootStat.dev
    || artifactRootInputStat.ino !== artifactRootStat.ino
    || artifactRootInputStat.isSymbolicLink()
    || !artifactRootInputStat.isDirectory()
    || !artifactRootStat.isDirectory()
    || artifactRootStat.isSymbolicLink()
  ) {
    throw new Error("package signature preflight artifact root is unsafe");
  }
  const repoRel = relative(root, artifactRoot);
  if (
    repoRel === ""
    || (!repoRel.startsWith(`..${sep}`) && repoRel !== ".." && !isAbsolute(repoRel))
  ) {
    throw new Error("package signature preflight artifact root must stay outside the repository");
  }
  const requestedOutput = resolve(
    isAbsolute(requested) ? requested : resolve(artifactRootInput, requested)
  );
  if (dirname(requestedOutput) !== artifactRootInput) {
    throw new Error("package signature preflight output must stay inside the artifact root");
  }
  const output = resolve(artifactRoot, basename(requestedOutput));
  return {
    boundary: {
      artifactRoot,
      dev: artifactRootStat.dev,
      ino: artifactRootStat.ino,
      parent: artifactRoot
    },
    output,
    root
  };
}

function requireAbsentRegularTargets(paths) {
  for (const path of paths) {
    try {
      lstatSync(path);
    } catch (cause) {
      if (cause && typeof cause === "object" && cause.code === "ENOENT") continue;
      throw cause;
    }
    throw new Error("package signature preflight target already exists or is unsafe");
  }
}

function archiveBytes(repoRoot) {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "archive", "--format=tar", "HEAD"],
    {
      ...commandOptions(repoRoot),
      encoding: null,
      maxBuffer: MAX_ARCHIVE_BYTES
    }
  );
  if (
    result.status !== 0
    || result.signal !== null
    || result.error
    || !Buffer.isBuffer(result.stdout)
    || result.stdout.byteLength <= 0
    || result.stdout.byteLength > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("package signature preflight archive failed");
  }
  return result.stdout;
}

function assertBoundParent(boundary) {
  const parent = realpathSync(boundary.parent);
  const stat = lstatSync(parent);
  const rel = relative(boundary.artifactRoot, parent);
  if (
    parent !== boundary.parent
    || !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== boundary.dev
    || stat.ino !== boundary.ino
    || rel === ".."
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) {
    throw new Error("package signature preflight output boundary changed");
  }
}

function writeExclusiveFile(path, bytes, boundary) {
  if (dirname(path) !== boundary.parent) {
    throw new Error("package signature preflight target escaped its bound parent");
  }
  assertBoundParent(boundary);
  const descriptor = openSync(
    path,
    constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("package signature preflight target is not regular");
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function readFinalRegularFile(path, boundary) {
  assertBoundParent(boundary);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("package signature preflight artifact boundary is unsafe");
  }
  return readFileSync(path);
}

function verifiedSourceSignature(signatures) {
  return signatures.commit === "verified"
    || signatures.tagsAtHead.some((tag) => tag.state === "verified");
}

export function buildPackageSignaturePreflight({
  candidateBytes,
  candidateName,
  generatedAt,
  releaseEvidence,
  releaseEvidenceName,
  releaseEvidenceSha256,
  repeatBytes,
  repeatName,
  source
}) {
  const firstSha256 = sha256(candidateBytes);
  const secondSha256 = sha256(repeatBytes);
  if (
    candidateBytes.byteLength !== repeatBytes.byteLength
    || firstSha256 !== secondSha256
    || !candidateBytes.equals(repeatBytes)
    || releaseEvidence.candidate.sha256 !== firstSha256
    || releaseEvidence.candidate.commit !== source.head
    || releaseEvidence.candidate.tree !== source.tree
    || !releaseEvidence.candidate.matchesCurrent
    || releaseEvidence.source.head !== source.head
    || releaseEvidence.source.tree !== source.tree
    || !releaseEvidence.source.clean
  ) {
    throw new Error("package signature preflight reproducibility or provenance failed");
  }
  const missingAuthority = [
    ...(verifiedSourceSignature(releaseEvidence.signatures) ? [] : ["verified-source-signature"]),
    ...(releaseEvidence.signatures.candidateDetached === "verified"
      ? []
      : ["verified-detached-candidate-signature"]),
    "installable-package-definition"
  ];
  const preimage = canonical({
    candidate: { byteSize: candidateBytes.byteLength, firstSha256, secondSha256 },
    releaseEvidence: {
      inputHash: releaseEvidence.inputHash,
      sha256: releaseEvidenceSha256
    },
    source
  });
  return {
    version: 1,
    generatedAt,
    inputHashAlgorithm: "sha256",
    inputHash: sha256(Buffer.from(JSON.stringify(preimage), "utf8")),
    source,
    package: {
      kind: "source-tree-archive",
      installable: false,
      candidateName,
      repeatName,
      byteSize: candidateBytes.byteLength,
      firstSha256,
      secondSha256,
      byteIdentical: true
    },
    signatureAvailability: {
      candidateDetached: releaseEvidence.signatures.candidateDetached,
      commit: releaseEvidence.signatures.commit,
      tagsAtHead: releaseEvidence.signatures.tagsAtHead
    },
    releaseEvidence: {
      inputHash: releaseEvidence.inputHash,
      name: releaseEvidenceName,
      overall: releaseEvidence.overall,
      reasons: releaseEvidence.reasons,
      sha256: releaseEvidenceSha256
    },
    decision: {
      gate: "red",
      availablePaths: ["reproducible-source-tree-archive", "release-evidence-scanner"],
      missingAuthority
    },
    effects: {
      archiveWrites: 2,
      credentialUse: 0,
      evidenceWrites: 2,
      network: 0,
      publication: 0,
      release: 0,
      signing: 0,
      tag: 0
    }
  };
}

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 ? argv[index + 1] : undefined;
}

function artifactRootArgument(argv) {
  const index = argv.indexOf("--artifact-root");
  return index >= 0 ? argv[index + 1] : undefined;
}

export function runPackageSignaturePreflight({
  argv = process.argv.slice(2),
  now = () => new Date(),
  repoRoot = process.cwd()
} = {}) {
  const generatedAt = now();
  if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
    throw new Error("package signature preflight time is invalid");
  }
  const { boundary, output, root } = safeEvidenceOutput(
    repoRoot,
    artifactRootArgument(argv),
    outputArgument(argv)
  );
  const sourceStart = capturePackagePreflightSource(root);
  if (sourceStart.worktree !== "clean" || sourceStart.head !== sourceStart.upstream) {
    throw new Error("package signature preflight requires clean source at its normal upstream");
  }
  const stem = `pa-s005-source-${sourceStart.head.slice(0, 9)}`;
  const candidate = resolve(dirname(output), `${stem}.tar`);
  const repeat = resolve(dirname(output), `${stem}-repeat.tar`);
  const releaseOutput = resolve(dirname(output), `${stem}-release-evidence.json`);
  requireAbsentRegularTargets([candidate, repeat, releaseOutput, output]);

  const candidateGenerated = archiveBytes(root);
  const repeatGenerated = archiveBytes(root);
  writeExclusiveFile(candidate, candidateGenerated, boundary);
  writeExclusiveFile(repeat, repeatGenerated, boundary);
  const releaseEvidence = evaluateReleaseEvidence({
    candidatePath: candidate,
    now: () => generatedAt,
    outputPath: releaseOutput,
    repoRoot: root,
    writeOutput: false
  });
  const releaseEvidenceBytes = Buffer.from(`${JSON.stringify(releaseEvidence, null, 2)}\n`, "utf8");
  writeExclusiveFile(releaseOutput, releaseEvidenceBytes, boundary);
  const sourceEnd = capturePackagePreflightSource(root);
  if (JSON.stringify(sourceEnd) !== JSON.stringify(sourceStart)) {
    throw new Error("package signature preflight source changed during inspection");
  }
  const candidateBytes = readFinalRegularFile(candidate, boundary);
  const repeatBytes = readFinalRegularFile(repeat, boundary);
  const finalReleaseEvidenceBytes = readFinalRegularFile(releaseOutput, boundary);
  const report = buildPackageSignaturePreflight({
    candidateBytes,
    candidateName: basename(candidate),
    generatedAt: generatedAt.toISOString(),
    releaseEvidence,
    releaseEvidenceName: basename(releaseOutput),
    releaseEvidenceSha256: sha256(finalReleaseEvidenceBytes),
    repeatBytes,
    repeatName: basename(repeat),
    source: sourceEnd
  });
  writeExclusiveFile(output, Buffer.from(`${JSON.stringify(report)}\n`, "utf8"), boundary);
  return report;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const report = runPackageSignaturePreflight();
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.stderr.write("package signature preflight failed\n");
    process.exitCode = 1;
  }
}
