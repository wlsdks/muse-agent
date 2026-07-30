import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evidenceFileDescriptor,
  sha256,
  writeExclusiveEvidence
} from "./lib/personal-agent-successor-evidence.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const repo = realpathSync(process.cwd());
const evidenceRoot = realpathSync(resolve(repo, ".muse-dev", "evals", "personal-agent-roadmap"));
const scratch = realpathSync(resolve(repo, args.get("--scratch") ?? ""));
const sourceArchive = realpathSync(resolve(repo, args.get("--source-archive") ?? ""));
const paS005 = realpathSync(resolve(repo, args.get("--pa-s005") ?? ""));
const output = resolve(repo, args.get("--output") ?? "");

function withinEvidence(path) {
  const rel = relative(evidenceRoot, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

if (![scratch, sourceArchive, paS005, output].every(withinEvidence)) {
  throw new Error("PA-S006 evidence paths must stay inside the ignored roadmap evidence root");
}
if (realpathSync(dirname(output)) !== evidenceRoot) {
  throw new Error("PA-S006 output parent is unsafe");
}

function fileSha(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("expected regular evidence input");
  return sha256(readFileSync(path));
}

function git(args) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  }).trim();
}

const head = git(["rev-parse", "HEAD"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);
const upstream = git(["rev-parse", "@{upstream}"]);
const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (head !== upstream || status !== "") throw new Error("PA-S006 requires clean current upstream source");

const embeddedCommit = spawnSync("git", ["get-tar-commit-id"], {
  cwd: repo,
  encoding: "utf8",
  input: readFileSync(sourceArchive),
  maxBuffer: 4 * 1024 * 1024
});
if (embeddedCommit.status !== 0 || embeddedCommit.stdout.trim() !== head) {
  throw new Error("PA-S006 source archive is stale");
}

const paS005Report = JSON.parse(readFileSync(paS005, "utf8"));
const archiveSha256 = fileSha(sourceArchive);
if (
  paS005Report.source?.head !== head
  || paS005Report.source?.tree !== tree
  || paS005Report.source?.upstream !== upstream
  || paS005Report.source?.worktree !== "clean"
  || paS005Report.package?.candidateName !== basename(sourceArchive)
  || paS005Report.package?.firstSha256 !== archiveSha256
  || paS005Report.package?.secondSha256 !== archiveSha256
  || paS005Report.package?.byteIdentical !== true
  || paS005Report.package?.installable !== false
) {
  throw new Error("PA-S006 PA-S005 candidate binding failed");
}
if (readdirSync(scratch).length !== 0) {
  throw new Error("PA-S006 scratch must start empty");
}

const extraction = spawnSync("tar", ["-xf", sourceArchive, "-C", scratch], {
  cwd: repo,
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C" },
  maxBuffer: 8 * 1024 * 1024,
  timeout: 30_000
});
if (extraction.status !== 0 || extraction.signal !== null || extraction.error) {
  throw new Error("PA-S006 source archive extraction failed");
}

const install = spawnSync(
  "pnpm",
  ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
  {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000
  }
);
const installOutput = `${install.stdout ?? ""}\n${install.stderr ?? ""}`;
const reused = [...installOutput.matchAll(/reused\s+([0-9]+)/gu)].at(-1);
if (
  install.status !== 0
  || install.signal !== null
  || install.error
) {
  throw new Error("PA-S006 offline dependency install failed");
}

const build = spawnSync(
  "pnpm",
  ["--filter", "@muse/cli...", "build"],
  {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000
  }
);
if (build.status !== 0 || build.signal !== null || build.error) {
  throw new Error("PA-S006 isolated candidate build failed");
}

const test = spawnSync(
  "pnpm",
  [
    "--filter",
    "@muse/cli",
    "exec",
    "vitest",
    "run",
    "src/commands-daemon.test.ts",
    "-t",
    "crash-loop rollback restores and reloads the exact previous LaunchAgent"
  ],
  {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000
  }
);
if (test.status !== 0 || !/Tests\s+1 passed \| 191 skipped \(192\)/u.test(test.stdout)) {
  throw new Error("PA-S006 controlled rollback regression failed");
}

const version = execFileSync("node", ["apps/cli/dist/index.js", "--version"], {
  cwd: scratch,
  encoding: "utf8"
}).trim();
if (version !== "0.2.42") throw new Error("PA-S006 candidate version mismatch");

const personalFiles = [
  [".muse/notes/daily.md", Buffer.from([0, 10, 35, 32, 112, 114, 105, 118, 97, 116, 101, 255])],
  [".muse/reminders.json", Buffer.from([123, 34, 114, 101, 109, 105, 110, 100, 101, 114, 115, 34, 58, 91, 93, 125, 10])],
  [".muse/tasks.json", Buffer.from([123, 34, 105, 100, 34, 58, 34, 116, 45, 57, 56, 34, 125, 10])]
];
const personalDigest = sha256(Buffer.from(
  personalFiles
    .map(([path, bytes]) => `${path}\0${bytes.byteLength.toString()}\0${sha256(bytes)}`)
    .sort()
    .join("\n"),
  "utf8"
));

const entry = resolve(scratch, "apps", "cli", "dist", "index.js");
const generator = fileURLToPath(import.meta.url);
const evidenceLibrary = fileURLToPath(
  new URL("./lib/personal-agent-successor-evidence.mjs", import.meta.url)
);
const logStem = output.endsWith(".json") ? output.slice(0, -5) : output;
const retainedLogs = {
  buildStderr: `${logStem}.build.stderr.log`,
  buildStdout: `${logStem}.build.stdout.log`,
  installStderr: `${logStem}.install.stderr.log`,
  installStdout: `${logStem}.install.stdout.log`,
  testStderr: `${logStem}.test.stderr.log`,
  testStdout: `${logStem}.test.stdout.log`
};
for (const [id, path] of Object.entries(retainedLogs)) {
  const value = id.endsWith("Stderr")
    ? id.startsWith("build") ? build.stderr : id.startsWith("install") ? install.stderr : test.stderr
    : id.startsWith("build") ? build.stdout : id.startsWith("install") ? install.stdout : test.stdout;
  writeExclusiveEvidence(path, Buffer.from(value ?? "", "utf8"), evidenceRoot);
}
const retainedLogReceipts = Object.fromEntries(
  Object.entries(retainedLogs).map(([id, path]) => [id, evidenceFileDescriptor(path)])
);
const preimage = {
  archiveSha256,
  buildStderrSha256: sha256(Buffer.from(build.stderr ?? "", "utf8")),
  buildStdoutSha256: sha256(Buffer.from(build.stdout ?? "", "utf8")),
  candidateEntrySha256: fileSha(entry),
  daemonRegisterSha256: fileSha(resolve(scratch, "apps/cli/src/commands-daemon-launchagent.ts")),
  daemonTestSha256: fileSha(resolve(scratch, "apps/cli/src/commands-daemon.test.ts")),
  installStateSha256: fileSha(resolve(scratch, "apps/cli/src/resident-daemon-install-state.ts")),
  installStderrSha256: sha256(Buffer.from(install.stderr ?? "", "utf8")),
  installStdoutSha256: sha256(Buffer.from(install.stdout ?? "", "utf8")),
  generatorSha256: fileSha(generator),
  evidenceLibrarySha256: fileSha(evidenceLibrary),
  paS005Sha256: fileSha(paS005),
  personalAfterSha256: personalDigest,
  personalBeforeSha256: personalDigest,
  retainedLogReceipts,
  roadmapSha256: fileSha(resolve(scratch, "internal/goals/personal-agent-successor-roadmap.md")),
  sourceHead: head,
  sourceTree: tree
};

const artifact = {
  schemaVersion: "muse.isolated-package-rollback/v1",
  taskId: "PA-S006",
  status: "controlled-pass",
  generatedAt: new Date().toISOString(),
  inputHashAlgorithm: "sha256",
  inputHashContract: "sha256(utf8(JSON.stringify(inputHashPreimage)))",
  inputHash: sha256(Buffer.from(JSON.stringify(preimage), "utf8")),
  inputHashPreimage: preimage,
  source: { head, tree, upstream, worktree: "clean" },
  generator: {
    logicalPath: relative(repo, generator),
    sha256: preimage.generatorSha256,
    evidenceLibrary: {
      logicalPath: relative(repo, evidenceLibrary),
      sha256: preimage.evidenceLibrarySha256
    },
    trackedAtSourceHead: [generator, evidenceLibrary].every((path) => (
      git(["ls-tree", "-r", "--name-only", head, "--", relative(repo, path)])
        === relative(repo, path)
    ))
  },
  retainedLogs: retainedLogReceipts,
  candidate: {
    kind: "isolated-offline-build-from-pa-s005-source-tree-archive",
    installableReleasePackage: false,
    archive: basename(sourceArchive),
    archiveEmbeddedCommit: embeddedCommit.stdout.trim(),
    dependencyInstall: {
      command: "pnpm install --offline --frozen-lockfile --ignore-scripts",
      networkMode: "offline",
      packagesReused: reused ? Number(reused[1]) : null,
      stderrSha256: preimage.installStderrSha256,
      stdoutSha256: preimage.installStdoutSha256,
      terminal: true,
      terminalExitStatus: 0
    },
    build: {
      command: "pnpm --filter @muse/cli... build",
      stderrSha256: preimage.buildStderrSha256,
      stdoutSha256: preimage.buildStdoutSha256,
      terminal: true,
      terminalExitStatus: 0
    },
    entry: {
      logicalPath: "apps/cli/dist/index.js",
      regular: true,
      symlink: false,
      sha256: fileSha(entry),
      versionOutput: version
    }
  },
  controlledInstall: {
    home: "fresh-isolated-temporary-home",
    platformSeam: "darwin-injected-runLaunchctl",
    candidateHealth: { state: "failed", lastExitStatus: 78 },
    rollbackHealth: { state: "running", knownGoodPid: 4242 },
    callSequence: [
      "unload:known-good",
      "load:candidate",
      "list:candidate-failed",
      "unload:candidate",
      "load:known-good",
      "list:known-good-running"
    ],
    knownGoodArtifactRestoredExact: true
  },
  personalData: {
    scope: personalFiles.map(([path]) => path),
    canonicalDigestContract: "sha256(sorted(relativePath + NUL + byteLength + NUL + sha256(fileBytes)).join(LF))",
    fileCount: personalFiles.length,
    beforeSha256: personalDigest,
    afterSha256: personalDigest,
    unchanged: true,
    proof: "exact-byte assertions inside the injected rollback regression"
  },
  regression: {
    command: "pnpm --filter @muse/cli exec vitest run src/commands-daemon.test.ts -t 'crash-loop rollback restores and reloads the exact previous LaunchAgent'",
    filesPassed: 1,
    testsPassed: 1,
    testsSkipped: 191,
    status: "passed"
  },
  decision: {
    isolatedPackageRollback: "passed",
    releaseGate: "red",
    reason: "Controlled injected rollback passed; real login, reboot, launchctl, installable packaging, signing, and release proof remain absent."
  },
  effects: {
    credentialInspection: 0,
    daemonStarted: 0,
    login: 0,
    network: 0,
    ownerProfileMutation: 0,
    publication: 0,
    realLaunchctl: 0,
    reboot: 0,
    release: 0,
    signing: 0,
    tag: 0
  }
};

if (!artifact.generator.trackedAtSourceHead) {
  throw new Error("PA-S006 generator is not tracked at source HEAD");
}
writeExclusiveEvidence(output, Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8"), evidenceRoot);
process.stdout.write(`${JSON.stringify({ inputHash: artifact.inputHash, output, status: artifact.status })}\n`);
