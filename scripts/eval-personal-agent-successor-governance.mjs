import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROLLBACK_BASELINE_HEAD,
  buildGovernanceBlockers,
  evidenceFileDescriptor,
  extractRollbackBaseline,
  monitorInputBindingsMatch,
  sha256,
  writeExclusiveEvidence
} from "./lib/personal-agent-successor-evidence.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const repo = realpathSync(process.cwd());
const evidenceRoot = realpathSync(resolve(repo, ".muse-dev", "evals", "personal-agent-roadmap"));
const output = resolve(repo, args.get("--output") ?? "");

function safeEvidencePath(flag) {
  const path = realpathSync(resolve(repo, args.get(flag) ?? ""));
  const rel = relative(evidenceRoot, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`unsafe PA-S008 input: ${flag}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe PA-S008 file: ${flag}`);
  return path;
}

if (realpathSync(dirname(output)) !== evidenceRoot || lstatSync(evidenceRoot).isSymbolicLink()) {
  throw new Error("unsafe PA-S008 output");
}

const paths = {
  s001: safeEvidencePath("--pa-s001"),
  s003: safeEvidencePath("--pa-s003"),
  s004: safeEvidencePath("--pa-s004"),
  s005: safeEvidencePath("--pa-s005"),
  s006: safeEvidencePath("--pa-s006"),
  s007: safeEvidencePath("--pa-s007")
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fileSha(path) {
  return sha256(readFileSync(path));
}

function git(args) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  }).trim();
}

const sourceStart = {
  head: git(["rev-parse", "HEAD"]),
  tree: git(["rev-parse", "HEAD^{tree}"]),
  upstream: git(["rev-parse", "@{upstream}"]),
  worktree: git(["status", "--porcelain=v1", "--untracked-files=all"]) === "" ? "clean" : "dirty"
};
if (sourceStart.head !== sourceStart.upstream || sourceStart.worktree !== "clean") {
  throw new Error("PA-S008 requires clean current upstream source");
}

const qualificationRun = spawnSync(
  "pnpm",
  ["--silent", "--filter", "@muse/cli", "dev", "qualify", "--json"],
  {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000
  }
);
if (qualificationRun.status !== 1 || qualificationRun.signal !== null || qualificationRun.error) {
  throw new Error("PA-S008 expected a current non-qualified terminal report");
}
const qualification = JSON.parse(
  qualificationRun.stdout.split(/\r?\n/u).filter((line) => line.startsWith("{")).at(-1)
);

const s001 = readJson(paths.s001);
const s003 = readJson(paths.s003);
const s004 = readJson(paths.s004);
const s005 = readJson(paths.s005);
const s006 = readJson(paths.s006);
const s007 = readJson(paths.s007);
const now = new Date();
const nextObservationAt = new Date(s007.nextObservationAt);
const s007GeneratedAt = new Date(s007.generatedAt);
const s007SourceIsAncestor = spawnSync(
  "git",
  ["merge-base", "--is-ancestor", s007.source?.head ?? "", sourceStart.head],
  {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  }
);
const s007SourceTree = s007.source?.head
  ? git(["rev-parse", `${s007.source.head}^{tree}`])
  : "";
const s007InputPaths = [
  [s007.inputs?.controlledJourney, s007.inputHashPreimage?.controlledJourneySha256],
  [s007.inputs?.legacyQualification, s007.inputHashPreimage?.legacyQualificationSha256],
  [s007.inputs?.trackedEvidence, s007.inputHashPreimage?.trackedEvidenceSha256]
];
const s007InputsValid = monitorInputBindingsMatch(s007)
  && s007InputPaths.every(([input, boundSha256]) => {
  if (!input?.path || !input?.sha256 || input.sha256 !== boundSha256) return false;
  const path = resolve(repo, input.path);
  const rel = relative(repo, path);
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink()
    && rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`)
    && fileSha(path) === input.sha256;
  });

for (const artifact of [s001, s003, s004, s005, s006]) {
  if (
    artifact.source?.head !== sourceStart.head
    || artifact.source?.tree !== sourceStart.tree
    || artifact.source?.upstream !== sourceStart.upstream
    || artifact.source?.worktree !== "clean"
  ) {
    throw new Error("PA-S008 current artifact provenance mismatch");
  }
}
if (
  qualification.provenance.source.start.revision !== sourceStart.head
  || qualification.provenance.source.end.revision !== sourceStart.head
  || qualification.provenance.source.start.tree !== "clean"
  || qualification.provenance.source.end.tree !== "clean"
  || qualification.status !== "not-qualified"
  || qualification.gates[0].status !== "failed"
  || qualification.gates[1].status !== "passed"
  || qualification.gates[2].status !== "unverified"
  || s001.taskId !== "PA-S001"
  || s001.status !== "inventory-complete"
  || s001.counts?.verifiedCurrent !== 0
  || s001.counts?.stale !== 3
  || s001.counts?.missing !== 6
  || s001.counts?.blocked !== 0
  || s001.counts?.requiredTotal !== 9
  || s003.releaseDecision?.gate !== "red"
  || !Number.isSafeInteger(s003.releaseDecision?.remainingUnclassified)
  || s003.releaseDecision.remainingUnclassified <= 0
  || s004.status !== "observed"
  || s005.decision?.gate !== "red"
  || s005.package?.installable !== false
  || s006.status !== "controlled-pass"
  || s006.decision?.releaseGate !== "red"
  || s007.decision?.organicEffectiveness !== "not-proven"
  || s007.taskId !== "Core100-099"
  || s007.status !== "monitoring"
  || s007.source?.head !== s007.inputHashPreimage?.sourceHead
  || s007.source?.tree !== s007.inputHashPreimage?.sourceTree
  || s007.source?.upstream !== s007.source?.head
  || s007.source?.head === sourceStart.head
  || s007.source?.worktree !== "clean"
  || s007SourceTree !== s007.source?.tree
  || s007SourceIsAncestor.status !== 0
  || s007SourceIsAncestor.signal !== null
  || s007SourceIsAncestor.error
  || !s007InputsValid
  || s007.inputHash !== sha256(Buffer.from(JSON.stringify(s007.inputHashPreimage), "utf8"))
  || !Number.isFinite(s007GeneratedAt.getTime())
  || nextObservationAt.getTime() - s007GeneratedAt.getTime() !== 24 * 60 * 60_000
  || !(nextObservationAt.getTime() > now.getTime())
) {
  throw new Error("PA-S008 gate invariant failed");
}

const sourceEnd = {
  head: git(["rev-parse", "HEAD"]),
  tree: git(["rev-parse", "HEAD^{tree}"]),
  upstream: git(["rev-parse", "@{upstream}"]),
  worktree: git(["status", "--porcelain=v1", "--untracked-files=all"]) === "" ? "clean" : "dirty"
};
if (JSON.stringify(sourceEnd) !== JSON.stringify(sourceStart)) {
  throw new Error("PA-S008 source changed during evaluation");
}

const roadmap = resolve(repo, "docs", "goals", "personal-agent-successor-roadmap.md");
const generator = fileURLToPath(import.meta.url);
const evidenceLibrary = fileURLToPath(
  new URL("./lib/personal-agent-successor-evidence.mjs", import.meta.url)
);
const generatorLogicalPath = relative(repo, generator);
const evidenceLibraryLogicalPath = relative(repo, evidenceLibrary);
if (
  extractRollbackBaseline(readFileSync(roadmap, "utf8")) !== ROLLBACK_BASELINE_HEAD
  || [generatorLogicalPath, evidenceLibraryLogicalPath].some((path) => (
    git(["ls-tree", "-r", "--name-only", sourceStart.head, "--", path]) !== path
  ))
) {
  throw new Error("PA-S008 tracked generator or rollback baseline contract is unavailable");
}
const receiptStem = output.endsWith(".json") ? output.slice(0, -5) : output;
const qualificationReportPath = `${receiptStem}.qualification.json`;
const qualificationStdoutPath = `${receiptStem}.qualification.stdout.log`;
const qualificationStderrPath = `${receiptStem}.qualification.stderr.log`;
writeExclusiveEvidence(
  qualificationReportPath,
  Buffer.from(`${JSON.stringify(qualification, null, 2)}\n`, "utf8"),
  evidenceRoot
);
writeExclusiveEvidence(
  qualificationStdoutPath,
  Buffer.from(qualificationRun.stdout ?? "", "utf8"),
  evidenceRoot
);
writeExclusiveEvidence(
  qualificationStderrPath,
  Buffer.from(qualificationRun.stderr ?? "", "utf8"),
  evidenceRoot
);
const qualificationReceipt = {
  report: evidenceFileDescriptor(qualificationReportPath),
  stdout: evidenceFileDescriptor(qualificationStdoutPath),
  stderr: evidenceFileDescriptor(qualificationStderrPath)
};
const inputHashPreimage = {
  generatorSha256: fileSha(generator),
  evidenceLibrarySha256: fileSha(evidenceLibrary),
  organicMonitorSha256: fileSha(paths.s007),
  paS001Sha256: fileSha(paths.s001),
  paS003Sha256: fileSha(paths.s003),
  paS004Sha256: fileSha(paths.s004),
  paS005Sha256: fileSha(paths.s005),
  paS006Sha256: fileSha(paths.s006),
  qualificationInputHash: qualification.provenance.inputHash,
  qualificationReportSha256: qualificationReceipt.report.sha256,
  qualificationStderrSha256: qualificationReceipt.stderr.sha256,
  qualificationStdoutSha256: qualificationReceipt.stdout.sha256,
  roadmapSha256: fileSha(roadmap),
  sourceHead: sourceStart.head,
  sourceTree: sourceStart.tree,
  sourceUpstream: sourceStart.upstream
};

const artifact = {
  schemaVersion: "muse.personal-agent-successor-governance/v1",
  taskId: "PA-S008",
  status: "decision-recorded",
  generatedAt: now.toISOString(),
  decision: "continue-with-successor",
  inputHashAlgorithm: "sha256",
  inputHashContract: "sha256(utf8(JSON.stringify(inputHashPreimage)))",
  inputHash: sha256(Buffer.from(JSON.stringify(inputHashPreimage), "utf8")),
  inputHashPreimage,
  source: sourceStart,
  generator: {
    logicalPath: generatorLogicalPath,
    sha256: inputHashPreimage.generatorSha256,
    evidenceLibrary: {
      logicalPath: evidenceLibraryLogicalPath,
      sha256: inputHashPreimage.evidenceLibrarySha256
    },
    trackedAtSourceHead: true
  },
  inputs: Object.fromEntries(Object.entries(paths).map(([id, path]) => [
    id,
    { name: basename(path), sha256: fileSha(path) }
  ])),
  gates: {
    capabilityInventory: {
      status: s001.status,
      inputHash: s001.inputHash,
      counts: s001.counts
    },
    qualification: {
      status: qualification.status,
      generatedAt: qualification.generatedAt,
      expiresAt: qualification.provenance.expiresAt,
      inputHash: qualification.provenance.inputHash,
      capability: qualification.gates[0].status,
      backgroundRuntime: qualification.gates[1].status,
      deliverySafety: qualification.gates[2].status,
      organicEffectiveness: qualification.effectiveness.status,
      receipt: qualificationReceipt
    },
    deliveryQueues: {
      status: s004.status,
      followups: s004.queues.followups,
      reminders: s004.queues.reminders,
      pendingDrafts: s004.queues.pendingDrafts
    },
    releaseEvidence: {
      status: "red",
      classifiedSlice: `${s003.slice.ruleId}:${s003.slice.scope}`,
      classifiedFindingCount: s003.releaseDecision.classifiedInThisSlice,
      remainingUnclassified: s003.releaseDecision.remainingUnclassified,
      sourceSignature: s005.signatureAvailability.commit,
      tagsAtHead: s005.signatureAvailability.tagsAtHead.length,
      candidateSignature: s005.signatureAvailability.candidateDetached,
      installablePackage: s005.package.installable
    },
    isolatedRollback: {
      status: s006.status,
      releaseClaim: false,
      realLaunchctl: false,
      loginOrReboot: false
    },
    organicMonitor: {
      status: "monitoring",
      organicEffectiveness: "not-proven",
      organicObservations: s007.denominators.organic.observations,
      explicitOutcomeLabels: s007.denominators.organic.explicitOutcomeLabels,
      nextObservationAt: s007.nextObservationAt,
      freshSnapshotsAfterThreshold: 0,
      historicalThresholdAuthority: true,
      sourceCurrent: s007.source.head === sourceStart.head,
      sourceHead: s007.source.head
    }
  },
  blockers: buildGovernanceBlockers({ qualification, s003, s004, s005, s006, s007 }),
  reason: "Background runtime and controlled rollback remain useful, but failed, unverified, red, and monitoring gates prohibit release-ready and do not justify termination.",
  next: {
    immediate: "After explicit owner confirmation that this Mac is idle, run at most one dependency-ready missing capability axis when its admission gate passes.",
    monitor: `At or after ${s007.nextObservationAt}, review one new organic outcome without waiting or promotion.`,
    release: "Keep the release gate red until all findings and signature/package authorities are independently resolved."
  },
  rollback: {
    baselineHead: ROLLBACK_BASELINE_HEAD,
    deliveryBrake: "keep-engaged",
    providerLock: "keep-local-log",
    selfLearningHold: "keep-engaged",
    sourceRollbackMethod: "verified normal git revert only; no reset, force, tag, release, or publication"
  },
  effects: {
    credentialUse: 0,
    delivery: 0,
    deliveryBrakeChange: 0,
    network: 0,
    policyPromotion: 0,
    publication: 0,
    release: 0,
    signing: 0,
    tag: 0
  }
};

writeExclusiveEvidence(output, Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8"), evidenceRoot);
process.stdout.write(`${JSON.stringify({
  decision: artifact.decision,
  inputHash: artifact.inputHash,
  output
})}\n`);
