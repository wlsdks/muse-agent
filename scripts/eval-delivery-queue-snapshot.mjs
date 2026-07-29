#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { collectDeliveryQueueSnapshot } from "../packages/autoconfigure/dist/index.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function gitText(args, cwd) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error("delivery queue evidence requires a readable Git source");
  return result.stdout.trim();
}

export function captureDeliveryQueueSource(repoRoot) {
  const head = gitText(["rev-parse", "HEAD"], repoRoot);
  const tree = gitText(["rev-parse", "HEAD^{tree}"], repoRoot);
  const upstream = gitText(["rev-parse", "@{upstream}"], repoRoot);
  const dirty = gitText(["status", "--porcelain=v1", "--untracked-files=all"], repoRoot);
  if (!REVISION.test(head) || !REVISION.test(tree) || !REVISION.test(upstream)) {
    throw new Error("delivery queue evidence source identity is invalid");
  }
  return {
    head,
    tree,
    upstream,
    worktree: dirty.length === 0 ? "clean" : "dirty"
  };
}

export function buildDeliveryQueueEvidence(snapshot, source) {
  const inputHashPreimage = canonical({ queues: snapshot, source });
  const report = {
    version: 1,
    generatedAt: snapshot.generatedAt,
    inputHashAlgorithm: "sha256",
    inputHash: sha256(Buffer.from(JSON.stringify(inputHashPreimage), "utf8")),
    source,
    readOnly: true,
    status: snapshot.status,
    queues: snapshot,
    effects: {
      artifactWrite: 1,
      delete: 0,
      providerCall: 0,
      queueMutation: 0,
      reschedule: 0,
      send: 0
    }
  };
  if (!SHA256.test(report.inputHash)) throw new Error("delivery queue evidence hash failed");
  return report;
}

function safeOutputPath(repoRoot, requested) {
  if (!requested) throw new Error("usage: eval-delivery-queue-snapshot --output <repo-contained-file>");
  const root = realpathSync(repoRoot);
  const evidenceRoot = resolve(root, ".muse-dev", "evals", "personal-agent-roadmap");
  mkdirSync(evidenceRoot, { mode: 0o700, recursive: true });
  const canonicalEvidenceRoot = realpathSync(evidenceRoot);
  const output = resolve(isAbsolute(requested) ? requested : resolve(root, requested));
  const rel = relative(canonicalEvidenceRoot, output);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("delivery queue evidence output must stay inside .muse-dev/evals/personal-agent-roadmap");
  }
  const parent = dirname(output);
  mkdirSync(parent, { mode: 0o700, recursive: true });
  if (realpathSync(parent) !== parent) throw new Error("delivery queue evidence output ancestry is unsafe");
  if (existsSync(output) && !lstatSync(output).isFile()) {
    throw new Error("delivery queue evidence output must be a regular file");
  }
  return output;
}

function atomicWrite(output, value) {
  const temporary = `${output}.${process.pid.toString()}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, output);
  chmodSync(output, 0o600);
}

function outputArgument(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runDeliveryQueueSnapshot({
  argv = process.argv.slice(2),
  env = process.env,
  repoRoot = process.cwd()
} = {}) {
  const output = safeOutputPath(repoRoot, outputArgument(argv));
  const sourceStart = captureDeliveryQueueSource(repoRoot);
  if (sourceStart.worktree !== "clean" || sourceStart.head !== sourceStart.upstream) {
    throw new Error("delivery queue evidence requires clean source at its normal upstream");
  }
  const snapshot = await collectDeliveryQueueSnapshot({ env });
  const sourceEnd = captureDeliveryQueueSource(repoRoot);
  if (JSON.stringify(sourceEnd) !== JSON.stringify(sourceStart)) {
    throw new Error("delivery queue evidence source changed during inspection");
  }
  const report = buildDeliveryQueueEvidence(snapshot, sourceEnd);
  atomicWrite(output, report);
  return report;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runDeliveryQueueSnapshot()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      if (report.status !== "observed") process.exitCode = 1;
    })
    .catch((cause) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : "delivery queue evidence failed"}\n`);
      process.exitCode = 1;
    });
}
