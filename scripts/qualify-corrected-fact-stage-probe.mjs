#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import {
  TASK_049_CORPUS,
  canonicalJson,
  classifyCorrectedFactStages,
  projectScoredStage,
  sha256,
  task049CorpusHash
} from "./lib/task-049-corrected-fact-probe.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(
  repoRoot,
  ".muse-dev",
  "evals",
  "personal-agent-roadmap",
  "task-049.json"
);
const INPUT_PATHS = Object.freeze([
  "scripts/qualify-corrected-fact-stage-probe.mjs",
  "scripts/lib/task-049-corrected-fact-probe.mjs",
  "scripts/task-049-corrected-fact-probe.test.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "packages/recall/package.json",
  "packages/recall/tsconfig.json",
  "packages/recall/src/index.ts",
  "packages/recall/src/ask-note-retrieval.ts",
  "packages/recall/src/pipeline.ts",
  "packages/recall/src/notes-index.ts",
  "packages/recall/src/conflict.ts",
  "packages/recall/src/chunks.ts",
  "packages/recall/src/live-files.ts",
  "packages/recall/dist/index.js",
  "packages/recall/dist/ask-note-retrieval.js",
  "packages/recall/dist/pipeline.js",
  "packages/recall/dist/notes-index.js",
  "packages/recall/dist/conflict.js",
  "packages/recall/dist/chunks.js"
]);
const CLASSIFICATIONS = new Set([
  "candidate_pair_missing",
  "rank_current_not_top1",
  "policy_current_not_top1",
  "pass"
]);

function jsonBytes(value) {
  return `${canonicalJson(value)}\n`;
}

async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

async function gitHead() {
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  const head = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("invalid git HEAD");
  return head;
}

async function inputManifest() {
  const entries = await Promise.all(INPUT_PATHS.map(async (path) => ({
    path,
    sha256: sha256(await readFile(join(repoRoot, path)))
  })));
  return Object.freeze({
    entries,
    sha256: sha256(jsonBytes(entries))
  });
}

function vectorForText(text) {
  const match = TASK_049_CORPUS.notes.filter((note) => text.includes(note.text));
  if (match.length !== 1) throw new Error("fixed corpus embedding lookup mismatch");
  return [...match[0].vector];
}

function deterministicFallbackVector(text) {
  const digest = createHash("sha256").update(text).digest();
  return [
    (digest[0] ?? 0) / 255,
    (digest[1] ?? 0) / 255,
    (digest[2] ?? 0) / 255
  ];
}

function assertArtifact(result) {
  const serialized = canonicalJson(result);
  if (
    result.schemaVersion !== "muse-personal-agent-roadmap-task-049.v1"
    || result.taskId !== "049-A"
    || result.executionStatus !== "pass"
    || !CLASSIFICATIONS.has(result.classification)
    || result.corpus.sha256 !== task049CorpusHash()
    || result.source.headStart !== result.source.headEnd
    || result.inputs.start.sha256 !== result.inputs.end.sha256
    || result.execution.skipped !== false
    || result.execution.unavailable !== false
    || result.execution.networkRequests !== 0
    || result.execution.generativeRequests !== 0
    || result.execution.queryEmbeddingCalls !== 1
    || result.execution.snapshotReused !== true
  ) {
    throw new Error("task-049 artifact invariant failed");
  }
  const recomputedClassification = classifyCorrectedFactStages({
    currentSourceId: TASK_049_CORPUS.currentSourceId,
    oldSourceId: TASK_049_CORPUS.oldSourceId,
    stages: result.stages,
    verdict: result.verdict
  });
  if (recomputedClassification !== result.classification) {
    throw new Error("task-049 classification projection mismatch");
  }
  if (
    serialized.includes(TASK_049_CORPUS.query)
    || TASK_049_CORPUS.notes.some((note) => serialized.includes(note.text))
  ) {
    throw new Error("task-049 artifact leaked corpus content");
  }
}

export async function runCorrectedFactStageProbe() {
  await rm(artifactPath, { force: true });
  const startedAt = new Date().toISOString();
  const headStart = await gitHead();
  const inputStart = await inputManifest();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "muse-task-049-"));
  const originalFetch = globalThis.fetch;
  let unexpectedNetworkRequests = 0;
  globalThis.fetch = async () => {
    unexpectedNetworkRequests += 1;
    throw new Error("task-049 network request denied");
  };
  let artifact;

  try {
    const {
      loadIndex,
      prepareGroundedRecall,
      reindexNotes,
      retrieveAndRankNotes
    } = await import("../packages/recall/dist/index.js");
    const notesDir = join(temporaryRoot, "notes");
    const indexPath = join(temporaryRoot, "notes-index.json");
    await mkdir(notesDir, { recursive: true });

    const sourceByPath = new Map();
    for (const note of TASK_049_CORPUS.notes) {
      const path = resolve(notesDir, `${note.sourceId}.md`);
      sourceByPath.set(path, note.sourceId);
      await writeFile(path, `${note.text}\n`, { mode: 0o600 });
    }
    const sourceForFile = (path) => sourceByPath.get(resolve(path)) ?? null;

    let indexEmbeddingCalls = 0;
    const fetchImpl = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
        throw new Error("external embedding request denied");
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (typeof body.prompt !== "string") throw new Error("invalid embedding request");
      indexEmbeddingCalls += 1;
      return new globalThis.Response(JSON.stringify({
        embedding: vectorForText(body.prompt)
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    const reindex = await reindexNotes({
      dir: notesDir,
      fetchImpl,
      force: true,
      indexPath,
      model: TASK_049_CORPUS.embedModel
    });
    const index = await loadIndex(indexPath);
    if (
      reindex.status !== "complete"
      || reindex.failed !== 0
      || reindex.embedded !== TASK_049_CORPUS.notes.length
      || indexEmbeddingCalls !== TASK_049_CORPUS.notes.length
      || !index
      || index.files.length !== TASK_049_CORPUS.notes.length
      || index.files.some((file) => file.chunks.length !== 1)
    ) {
      throw new Error("disposable production index invariant failed");
    }

    let queryEmbeddingCalls = 0;
    let nonQueryEmbeddingCalls = 0;
    const embedFn = async (text) => {
      if (text === TASK_049_CORPUS.query) {
        queryEmbeddingCalls += 1;
        if (queryEmbeddingCalls > 1) {
          throw new Error("retrieval snapshot was not reused");
        }
        return [...TASK_049_CORPUS.queryVector];
      }
      nonQueryEmbeddingCalls += 1;
      return deterministicFallbackVector(text);
    };
    const env = Object.freeze({
      MUSE_RECALL_GRAPH_HOP: "false",
      MUSE_RECALL_SECOND_HOP: "false"
    });
    const retrieval = await retrieveAndRankNotes({
      conflictAwareSelection: true,
      embedFn,
      embedModel: TASK_049_CORPUS.embedModel,
      env,
      indexFiles: index.files,
      json: true,
      notesDir,
      onStderr: () => {},
      query: TASK_049_CORPUS.query,
      scope: undefined,
      snapshotIdentity: {
        indexBuiltAtIso: index.builtAtIso,
        notesIndexFile: indexPath
      },
      topK: TASK_049_CORPUS.topK
    });
    if (!retrieval.snapshot) throw new Error("production retrieval snapshot missing");

    const prepared = await prepareGroundedRecall({
      embedFn,
      options: {
        conflictAwareSelection: true,
        embedModel: TASK_049_CORPUS.embedModel,
        topK: TASK_049_CORPUS.topK
      },
      query: TASK_049_CORPUS.query,
      rerankFn: retrieval.snapshot.rerankFn,
      retrievalSnapshot: retrieval.snapshot,
      sources: {
        notesDir,
        notesIndexFile: indexPath
      }
    });
    if (
      queryEmbeddingCalls !== 1
      || retrieval.notesUnavailable
      || prepared.notesUnavailable
      || unexpectedNetworkRequests !== 0
    ) {
      throw new Error("retrieval snapshot reuse or availability invariant failed");
    }

    const stages = Object.freeze({
      candidate: projectScoredStage(retrieval.preGapScored, sourceForFile),
      policy: projectScoredStage(prepared.scored, sourceForFile),
      rank: projectScoredStage(retrieval.scored, sourceForFile)
    });
    const classification = classifyCorrectedFactStages({
      currentSourceId: TASK_049_CORPUS.currentSourceId,
      oldSourceId: TASK_049_CORPUS.oldSourceId,
      stages,
      verdict: prepared.verdict
    });

    const headEnd = await gitHead();
    const inputEnd = await inputManifest();
    artifact = {
      classification,
      completedAt: new Date().toISOString(),
      corpus: {
        noteCount: TASK_049_CORPUS.notes.length,
        sha256: task049CorpusHash(),
        version: TASK_049_CORPUS.version
      },
      execution: {
        generativeRequests: 0,
        indexEmbeddingCalls,
        networkRequests: unexpectedNetworkRequests,
        nonQueryEmbeddingCalls,
        queryEmbeddingCalls,
        skipped: false,
        snapshotReused: queryEmbeddingCalls === 1,
        unavailable: false
      },
      executionStatus: "pass",
      index: {
        files: index.files.length,
        schemaVersion: index.version,
        totalChunks: index.files.reduce((sum, file) => sum + file.chunks.length, 0)
      },
      inputs: {
        end: inputEnd,
        start: inputStart
      },
      schemaVersion: "muse-personal-agent-roadmap-task-049.v1",
      source: {
        headEnd,
        headStart
      },
      stages,
      startedAt,
      taskId: "049-A",
      verdict: prepared.verdict
    };
    assertArtifact(artifact);
    await writeAtomic(artifactPath, jsonBytes(artifact));
    return artifact;
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function main() {
  const result = await runCorrectedFactStageProbe();
  process.stdout.write(`${canonicalJson({
    artifact: ".muse-dev/evals/personal-agent-roadmap/task-049.json",
    classification: result.classification,
    corpusSha256: result.corpus.sha256,
    head: result.source.headEnd,
    status: result.executionStatus,
    verdict: result.verdict
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
