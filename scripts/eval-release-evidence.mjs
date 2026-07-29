#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT = 128 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_COUNT = 50_000;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_FINDINGS = 10_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const RULES = [
  { id: "aws-access-key-id", pattern: /\bAKIA[A-Z0-9]{16}\b/gu },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gu },
  { id: "openai-token", pattern: /\bsk-[A-Za-z0-9_-]{20,255}\b/gu },
  { id: "personal-email", pattern: /\b[A-Za-z0-9._%+-]+@(?:daum\.net|gmail\.com|icloud\.com|naver\.com)\b/gu },
  { id: "private-key-header", pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu },
  { id: "personal-home-path", pattern: /\/Users\/[A-Za-z0-9._-]+\//gu }
];

export function evaluateReleaseEvidence({
  candidatePath,
  outputPath,
  repoRoot = process.cwd(),
  spawn = spawnSync,
  now = () => new Date()
}) {
  if (!candidatePath || !outputPath) throw new Error("explicit candidate and output paths are required");
  const root = resolve(repoRoot);
  const candidate = resolve(candidatePath);
  const output = resolve(outputPath);
  assertRegularNonSymlink(candidate, "candidate boundary is unsafe");
  assertIgnoredOutput({ output, root, spawn });

  const source = captureSource(root, spawn);
  const candidateStat = lstatSync(candidate);
  if (candidateStat.size > MAX_CANDIDATE_BYTES) {
    throw new Error("candidate exceeds bounded scan size");
  }
  const candidateBytes = readFileSync(candidate);
  const candidateSha256 = sha256(candidateBytes);
  const embeddedCommit = gitTarCommit(candidateBytes, root, spawn);
  const candidateTree = embeddedCommit
    ? runText(spawn, "git", ["rev-parse", `${embeddedCommit}^{tree}`], root).value
    : undefined;
  const sourceScan = scanSourceTree(root, spawn);
  const candidateScan = scanTar(candidate, root, spawn);
  const combinedFindings = [...sourceScan.findings, ...candidateScan.findings];
  const findings = combinedFindings.slice(0, MAX_FINDINGS).sort(compareFindings);
  const signatures = captureSignatures({ candidate, head: source.head, root, spawn });
  const candidateMatches = Boolean(
    embeddedCommit
      && candidateTree
      && embeddedCommit === source.head
      && candidateTree === source.tree
  );
  const reasons = [];
  if (!source.clean) reasons.push("source-dirty");
  if (!candidateMatches) reasons.push("candidate-mismatch");
  if (sourceScan.status !== "complete" || candidateScan.status !== "complete") reasons.push("scan-skipped");
  if (findings.length > 0) reasons.push("unclassified-finding");
  if (
    signatures.commit !== "verified"
    && !signatures.tagsAtHead.some((tag) => tag.state === "verified")
  ) reasons.push("source-signature-unverified");
  if (signatures.candidateDetached !== "verified") reasons.push("candidate-signature-unverified");

  const report = {
    version: 1,
    generatedAt: now().toISOString(),
    inputHashAlgorithm: "sha256",
    inputHash: releaseEvidenceInputHash({
      candidateSha256,
      sourceHead: source.head,
      sourceTree: source.tree
    }),
    overall: reasons.length === 0 ? "green" : "red",
    reasons,
    source,
    candidate: {
      byteSize: candidateBytes.byteLength,
      commit: embeddedCommit ?? null,
      matchesCurrent: candidateMatches,
      name: basename(candidate),
      sha256: candidateSha256,
      tree: candidateTree ?? null
    },
    scans: {
      candidate: {
        bytes: candidateScan.bytes,
        duplicateEntries: candidateScan.duplicateEntries,
        entries: candidateScan.entries,
        specialEntries: candidateScan.specialEntries,
        status: candidateScan.status,
        tool: candidateScan.tool
      },
      source: {
        bytes: sourceScan.bytes,
        duplicateEntries: 0,
        entries: sourceScan.entries,
        specialEntries: sourceScan.specialEntries,
        status: sourceScan.status,
        tool: "git-ls-files"
      }
    },
    signatures,
    findings
  };
  atomicWriteJson(output, report);
  return report;
}

function releaseEvidenceInputHash({ candidateSha256, sourceHead, sourceTree }) {
  return sha256(Buffer.from(JSON.stringify({
    candidateSha256,
    ruleIds: RULES.map(({ id }) => id).sort(),
    rulePatterns: RULES.map(({ id, pattern }) => ({ id, flags: pattern.flags, source: pattern.source }))
      .sort((left, right) => compareText(left.id, right.id)),
    sourceHead,
    sourceTree,
    version: 1
  }), "utf8"));
}

function captureSource(root, spawn) {
  const head = requireGitText(spawn, ["rev-parse", "HEAD"], root, "git HEAD unavailable");
  const tree = requireGitText(spawn, ["rev-parse", "HEAD^{tree}"], root, "git tree unavailable");
  const status = requireGitText(
    spawn,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root,
    "git status unavailable",
    true
  );
  return { clean: status.length === 0, head, tree };
}

function gitTarCommit(bytes, root, spawn) {
  const result = spawn("git", ["get-tar-commit-id"], commandOptions(root, { input: bytes }));
  if (!succeeded(result)) return undefined;
  const value = String(result.stdout).trim();
  return /^[a-f0-9]{40,64}$/u.test(value) ? value : undefined;
}

function scanSourceTree(root, spawn) {
  const listed = runBuffer(spawn, "git", ["ls-files", "-z"], root);
  if (!listed.ok) return emptySkippedScan();
  const paths = listed.value.toString("utf8").split("\0").filter(Boolean).sort();
  const findings = [];
  let skipped = false;
  let bytes = 0;
  let entries = 0;
  let specialEntries = 0;
  if (paths.length > MAX_ENTRY_COUNT) skipped = true;
  for (const path of paths.slice(0, MAX_ENTRY_COUNT)) {
    entries += 1;
    if (!safeRelativePath(path)) {
      skipped = true;
      continue;
    }
    try {
      const file = join(root, ...path.split("/"));
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        skipped = true;
        specialEntries += 1;
        continue;
      }
      if (stat.size > MAX_ENTRY_BYTES || bytes + stat.size > MAX_TOTAL_SCAN_BYTES) {
        skipped = true;
        continue;
      }
      const content = readFileSync(file);
      bytes += content.byteLength;
      const scanned = scanBytes(content, "source", path, MAX_FINDINGS - findings.length);
      findings.push(...scanned.findings);
      if (scanned.truncated) skipped = true;
    } catch {
      skipped = true;
    }
  }
  return { bytes, entries, findings, specialEntries, status: skipped ? "skipped" : "complete" };
}

function scanTar(candidate, root, spawn) {
  const available = runText(spawn, "tar", ["--version"], root);
  if (!available.ok) return { ...emptySkippedScan(), tool: "tar-unavailable" };
  const listed = runText(spawn, "tar", ["-tf", candidate], root);
  if (!listed.ok) return { ...emptySkippedScan(), tool: "tar" };
  const paths = listed.value.split(/\r?\n/u).filter(Boolean).sort();
  const pathCounts = new Map();
  for (const path of paths) pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  const findings = [];
  let skipped = false;
  let bytes = 0;
  let duplicateEntries = 0;
  let entries = 0;
  let specialEntries = 0;
  if (paths.length > MAX_ENTRY_COUNT) skipped = true;
  for (const path of paths.slice(0, MAX_ENTRY_COUNT)) {
    entries += 1;
    if ((pathCounts.get(path) ?? 0) !== 1) {
      duplicateEntries += 1;
      skipped = true;
      continue;
    }
    if (!safeRelativePath(path.replace(/\/$/u, ""))) {
      skipped = true;
      continue;
    }
    const described = runText(spawn, "tar", ["-tvf", candidate, "--", path], root);
    if (!described.ok || described.value.length === 0) {
      skipped = true;
      continue;
    }
    const entryType = described.value[0];
    if (entryType === "d" && path.endsWith("/")) continue;
    if (entryType !== "-") {
      skipped = true;
      specialEntries += 1;
      continue;
    }
    const extracted = runBuffer(spawn, "tar", ["-xOf", candidate, "--", path], root);
    if (
      !extracted.ok
      || extracted.value.byteLength > MAX_ENTRY_BYTES
      || bytes + extracted.value.byteLength > MAX_TOTAL_SCAN_BYTES
    ) {
      skipped = true;
      continue;
    }
    bytes += extracted.value.byteLength;
    const scanned = scanBytes(
      extracted.value,
      "candidate",
      path,
      MAX_FINDINGS - findings.length
    );
    findings.push(...scanned.findings);
    if (scanned.truncated) skipped = true;
  }
  return {
    bytes,
    duplicateEntries,
    entries,
    findings,
    specialEntries,
    status: skipped ? "skipped" : "complete",
    tool: "tar"
  };
}

function scanBytes(bytes, scope, path, remainingFindings) {
  const text = bytes.toString("utf8");
  const findings = [];
  let truncated = remainingFindings <= 0;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (findings.length >= remainingFindings) {
        truncated = true;
        break;
      }
      findings.push({
        line: lineNumber(text, match.index ?? 0),
        matchHash: sha256(Buffer.from(match[0], "utf8")),
        path,
        ruleId: rule.id,
        scope
      });
    }
    if (truncated) break;
  }
  return { findings, truncated };
}

function captureSignatures({ candidate, head, root, spawn }) {
  const commit = runText(spawn, "git", ["verify-commit", head], root).ok ? "verified" : "unverified";
  const tagsResult = runText(spawn, "git", ["tag", "--points-at", head], root);
  const tagNames = tagsResult.ok ? tagsResult.value.split(/\r?\n/u).filter(Boolean).sort() : [];
  const tagsAtHead = tagNames.map((name) => ({
    name,
    state: runText(spawn, "git", ["verify-tag", name], root).ok ? "verified" : "unverified"
  }));
  const detached = [`${candidate}.sig`, `${candidate}.asc`]
    .filter((file) => isRegularNonSymlink(file));
  return {
    candidateDetached: detached.length === 0 ? "absent" : "present-unverified",
    commit,
    tagsAtHead
  };
}

function assertIgnoredOutput({ output, root, spawn }) {
  const rel = relative(root, output);
  if (!safeRelativePath(rel.split(sep).join("/"))) throw new Error("output must be git-ignored");
  assertNoSymlinkAncestry(root, dirname(output));
  const ignored = spawn(
    "git",
    ["check-ignore", "--quiet", "--no-index", "--", rel],
    commandOptions(root)
  );
  if (!succeeded(ignored)) throw new Error("output must be git-ignored");
  assertSafeExistingOutput(output);
}

function assertNoSymlinkAncestry(root, targetParent) {
  let current = root;
  for (const segment of relative(root, targetParent).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("output boundary is unsafe");
  }
}

function atomicWriteJson(output, value) {
  mkdirSync(dirname(output), { mode: 0o700, recursive: true });
  const temporary = `${output}.tmp-${process.pid.toString()}-${randomUUID()}`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("report exceeds bounded size");
  }
  try {
    writeFileSync(temporary, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    assertSafeExistingOutput(output);
    renameSync(temporary, output);
    if (process.platform !== "win32") chmodSync(output, 0o600);
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

function assertSafeExistingOutput(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("output boundary is unsafe");
}

function emptySkippedScan() {
  return {
    bytes: 0,
    duplicateEntries: 0,
    entries: 0,
    findings: [],
    specialEntries: 0,
    status: "skipped"
  };
}

function assertRegularNonSymlink(path, message) {
  if (!isRegularNonSymlink(path)) throw new Error(message);
}

function isRegularNonSymlink(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRelativePath(path) {
  return path.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && !path.includes("\\")
    && !isAbsolute(path)
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function requireGitText(spawn, args, root, message, allowEmpty = false) {
  const result = runText(spawn, "git", args, root);
  if (!result.ok || (!allowEmpty && result.value.length === 0)) throw new Error(message);
  return result.value;
}

function runText(spawn, command, args, cwd) {
  const result = spawn(command, args, commandOptions(cwd));
  return succeeded(result)
    ? { ok: true, value: String(result.stdout).trim() }
    : { ok: false, value: "" };
}

function runBuffer(spawn, command, args, cwd) {
  const result = spawn(command, args, commandOptions(cwd, { encoding: "buffer" }));
  return succeeded(result)
    ? { ok: true, value: Buffer.from(result.stdout) }
    : { ok: false, value: Buffer.alloc(0) };
}

function commandOptions(cwd, extra = {}) {
  return {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    maxBuffer: MAX_COMMAND_OUTPUT,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    ...extra
  };
}

function succeeded(result) {
  return result && result.status === 0 && result.signal === null && !result.error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function lineNumber(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function compareFindings(left, right) {
  return compareText(left.scope, right.scope)
    || compareText(left.path, right.path)
    || left.line - right.line
    || compareText(left.ruleId, right.ruleId)
    || compareText(left.matchHash, right.matchHash);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCli(argv) {
  let candidatePath;
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag === "--package-candidate" || flag === "--output") && value && !value.startsWith("--")) {
      if (flag === "--package-candidate") candidatePath = value;
      else outputPath = value;
      index += 1;
      continue;
    }
    throw new Error("usage: eval-release-evidence --package-candidate <tar> --output <ignored-json>");
  }
  if (!candidatePath || !outputPath) {
    throw new Error("usage: eval-release-evidence --package-candidate <tar> --output <ignored-json>");
  }
  return { candidatePath, outputPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = evaluateReleaseEvidence(options);
    process.stdout.write(`${JSON.stringify({ output: resolve(options.outputPath), overall: report.overall })}\n`);
    if (report.overall !== "green") process.exitCode = 1;
  } catch {
    process.stderr.write("release evidence evaluation failed\n");
    process.exitCode = 1;
  }
}
