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
  canonicalJson,
  sha256
} from "./lib/task-049-corrected-fact-probe.mjs";
import {
  TASK_050_CORPUS,
  assessCorrectionPairRetention,
  assessOrdinaryTop1,
  task050CorpusHash
} from "./lib/task-050-pair-retention-probe.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = join(repoRoot, ".muse-dev", "evals", "personal-agent-roadmap", "task-050.json");
const INPUT_PATHS = Object.freeze([
  "scripts/qualify-correction-pair-retention.mjs",
  "scripts/lib/task-049-corrected-fact-probe.mjs",
  "scripts/lib/task-050-pair-retention-probe.mjs",
  "scripts/task-050-pair-retention-probe.test.mjs",
  "scripts/qualify-corrected-fact-stage-probe.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "packages/recall/package.json",
  "packages/recall/tsconfig.json",
  "packages/recall/src/index.ts",
  "packages/recall/src/ask-note-retrieval.ts",
  "packages/recall/src/ask-note-retrieval.test.ts",
  "packages/recall/src/chunks.ts",
  "packages/recall/src/conflict.ts",
  "packages/recall/src/notes-index.ts",
  "apps/cli/src/commands-ask-adaptive-k.test.ts",
  "packages/recall/dist/index.js",
  "packages/recall/dist/ask-note-retrieval.js",
  "packages/recall/dist/chunks.js",
  "packages/recall/dist/conflict.js",
  "packages/recall/dist/notes-index.js"
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
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const head = stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error("invalid git HEAD");
  return head;
}

async function inputManifest() {
  const entries = await Promise.all(INPUT_PATHS.map(async (path) => ({
    path,
    sha256: sha256(await readFile(join(repoRoot, path)))
  })));
  return Object.freeze({ entries, sha256: sha256(jsonBytes(entries)) });
}

function deterministicFallbackVector(text) {
  const digest = createHash("sha256").update(text).digest();
  return [(digest[0] ?? 0) / 255, (digest[1] ?? 0) / 255, (digest[2] ?? 0) / 255];
}

function vectorForNote(text) {
  const matches = TASK_050_CORPUS.notes.filter((note) => text.includes(note.text));
  if (matches.length !== 1) throw new Error("Task050 fixed note embedding lookup mismatch");
  return [...matches[0].vector];
}

function sourceIds(scored, sourceForFile) {
  const ids = scored.map((item) => sourceForFile(item.file));
  if (ids.some((id) => typeof id !== "string")) throw new Error("Task050 unknown source identity");
  return ids;
}

function assertArtifact(result) {
  const serialized = canonicalJson(result);
  const expectedCorrectionIds = TASK_050_CORPUS.cases.map((item) => item.id);
  const expectedCaseIds = [...expectedCorrectionIds, TASK_050_CORPUS.ordinary.id];
  const actualCaseIds = Array.isArray(result.cases) ? result.cases.map((item) => item.id) : [];
  const uniqueCaseIds = new Set(actualCaseIds);
  const correctionRows = expectedCorrectionIds.map((id) => result.cases?.find((item) => item.id === id));
  const ordinaryRow = result.cases?.find((item) => item.id === TASK_050_CORPUS.ordinary.id);
  const recomputedCorrectionPasses = correctionRows.filter((item) => item?.passed === true).length;
  const failures = [
    result.schemaVersion === "muse-personal-agent-roadmap-task-050.v1" ? null : "schema",
    result.taskId === "050-A" ? null : "task",
    result.executionStatus === "pass" ? null : "status",
    result.corpus.sha256 === task050CorpusHash() ? null : "corpus",
    result.source.headStart === result.source.headEnd ? null : "head",
    result.inputs.start.sha256 === result.inputs.end.sha256 ? null : "inputs",
    result.execution.networkRequests === 0 ? null : "network",
    result.execution.generativeRequests === 0 ? null : "generative",
    result.execution.indexEmbeddingCalls === TASK_050_CORPUS.notes.length ? null : "index-embeddings",
    result.execution.queryEmbeddingCalls === TASK_050_CORPUS.cases.length + 2 ? null : "query-embeddings",
    result.execution.nonQueryEmbeddingCalls === 0 ? null : "non-query-embeddings",
    result.execution.skipped === false ? null : "skipped",
    result.execution.unavailable === false ? null : "unavailable",
    canonicalJson(actualCaseIds) === canonicalJson(expectedCaseIds) && uniqueCaseIds.size === expectedCaseIds.length ? null : "case-set",
    result.summary.correctionCasesPassed === recomputedCorrectionPasses && recomputedCorrectionPasses === expectedCorrectionIds.length ? null : "correction-pass",
    result.summary.correctionCasesTotal === expectedCorrectionIds.length ? null : "correction-total",
    result.summary.ordinaryTop1Preserved === ordinaryRow?.passed && ordinaryRow?.passed === true ? null : "ordinary-top1",
    result.cases.every((item) => item.passed === true && item.retainedCount <= TASK_050_CORPUS.topK) ? null : "case-bound"
  ].filter(Boolean);
  if (failures.length > 0) {
    const failedCases = result.cases.filter((item) => item.passed !== true).map((item) => item.id);
    throw new Error(`Task050 artifact invariant failed: ${failures.join(",")}; cases=${failedCases.join(",")}; evidence=${canonicalJson(result.cases)}`);
  }
  if (
    serialized.includes(TASK_050_CORPUS.ordinary.query)
    || TASK_050_CORPUS.cases.some((item) => serialized.includes(item.query))
    || TASK_050_CORPUS.notes.some((note) => serialized.includes(note.text))
  ) throw new Error("Task050 artifact leaked corpus content");
}

export async function runCorrectionPairRetentionProbe() {
  await rm(artifactPath, { force: true });
  const startedAt = new Date().toISOString();
  const headStart = await gitHead();
  const inputStart = await inputManifest();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "muse-task-050-"));
  const originalFetch = globalThis.fetch;
  let unexpectedNetworkRequests = 0;
  globalThis.fetch = async () => {
    unexpectedNetworkRequests += 1;
    throw new Error("Task050 network request denied");
  };

  try {
    const { loadIndex, reindexNotes, retrieveAndRankNotes } = await import("../packages/recall/dist/index.js");
    const notesDir = join(temporaryRoot, "notes");
    const indexPath = join(temporaryRoot, "notes-index.json");
    await mkdir(notesDir, { recursive: true });
    const sourceByPath = new Map();
    for (const note of TASK_050_CORPUS.notes) {
      const path = resolve(notesDir, `${note.sourceId}.md`);
      sourceByPath.set(path, note.sourceId);
      await writeFile(path, `${note.text}\n`, { mode: 0o600 });
    }
    const sourceForFile = (path) => sourceByPath.get(resolve(path)) ?? null;

    let indexEmbeddingCalls = 0;
    const fetchImpl = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) throw new Error("external embedding request denied");
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (typeof body.prompt !== "string") throw new Error("invalid embedding request");
      indexEmbeddingCalls += 1;
      return new globalThis.Response(JSON.stringify({ embedding: vectorForNote(body.prompt) }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };
    const reindex = await reindexNotes({
      dir: notesDir,
      fetchImpl,
      force: true,
      indexPath,
      model: TASK_050_CORPUS.embedModel
    });
    const index = await loadIndex(indexPath);
    if (
      reindex.status !== "complete"
      || reindex.failed !== 0
      || reindex.embedded !== TASK_050_CORPUS.notes.length
      || indexEmbeddingCalls !== TASK_050_CORPUS.notes.length
      || !index
      || index.files.length !== TASK_050_CORPUS.notes.length
    ) throw new Error("Task050 disposable index invariant failed");

    const queryVectors = new Map([
      ...TASK_050_CORPUS.cases.map((item) => [item.query, item.queryVector]),
      [TASK_050_CORPUS.ordinary.query, TASK_050_CORPUS.ordinary.queryVector]
    ]);
    let queryEmbeddingCalls = 0;
    let nonQueryEmbeddingCalls = 0;
    const embedFn = async (text) => {
      const vector = queryVectors.get(text);
      if (vector) {
        queryEmbeddingCalls += 1;
        return [...vector];
      }
      nonQueryEmbeddingCalls += 1;
      return deterministicFallbackVector(text);
    };
    const env = Object.freeze({ MUSE_RECALL_GRAPH_HOP: "false", MUSE_RECALL_SECOND_HOP: "false" });
    const retrieve = (query, conflictAwareSelection, indexFiles = index.files, rerankFn) => retrieveAndRankNotes({
      conflictAwareSelection,
      embedFn,
      embedModel: TASK_050_CORPUS.embedModel,
      env,
      indexFiles,
      json: true,
      notesDir,
      onStderr: () => {},
      query,
      ...(rerankFn ? { rerankFn } : {}),
      scope: undefined,
      topK: TASK_050_CORPUS.topK
    });

    const correctionCases = [];
    for (const testCase of TASK_050_CORPUS.cases) {
      const caseFiles = index.files.filter((file) => {
        const sourceId = sourceForFile(file.path);
        return sourceId === testCase.oldSourceId
          || sourceId === testCase.currentSourceId
          || sourceId?.startsWith(`${testCase.id}-noise-`);
      });
      if (caseFiles.length !== 4) throw new Error("Task050 independent pair slice mismatch");
      const currentText = TASK_050_CORPUS.notes.find((note) => note.sourceId === testCase.currentSourceId)?.text;
      const oldText = TASK_050_CORPUS.notes.find((note) => note.sourceId === testCase.oldSourceId)?.text;
      if (!currentText || !oldText) throw new Error("Task050 pair text fixture missing");
      let allowedCorrectionPairCount = -1;
      let selectorCandidateCount = -1;
      let selectorInvocations = 0;
      const rerankFn = Object.assign(async (_query, texts, context) => {
        selectorInvocations += 1;
        selectorCandidateCount = texts.length;
        allowedCorrectionPairCount = context?.allowedCorrectionPairs?.length ?? -1;
        const current = texts.indexOf(currentText);
        const stale = texts.indexOf(oldText);
        if (current < 0 || stale < 0) {
          return { httpAttempts: 0, order: [], outcome: "invalid" };
        }
        return {
          httpAttempts: 0,
          order: [
            current,
            ...texts.map((_text, index) => index).filter((index) => index !== current && index !== stale),
            stale
          ],
          outcome: "success",
          pairHints: [{ current, stale }]
        };
      }, { mode: "correction-pair" });
      const retained = await retrieve(testCase.query, true, caseFiles, rerankFn);
      if (retained.notesUnavailable) throw new Error("Task050 correction retrieval unavailable");
      const verifiedPairPresent = (
        sourceForFile(retained.verifiedCorrectionPair?.current.file) === testCase.currentSourceId
        && sourceForFile(retained.verifiedCorrectionPair?.stale.file) === testCase.oldSourceId
      );
      const assessment = assessCorrectionPairRetention({
        currentSourceId: testCase.currentSourceId,
        oldSourceId: testCase.oldSourceId,
        preMmrSourceIds: sourceIds(retained.preGapScored, sourceForFile),
        retainedSourceIds: sourceIds(retained.scored, sourceForFile),
        topK: TASK_050_CORPUS.topK
      });
      correctionCases.push(Object.freeze({
        ...assessment,
        allowedCorrectionPairCount,
        id: testCase.id,
        passed: (
          assessment.passed
          && verifiedPairPresent
          && selectorInvocations === 1
          && selectorCandidateCount > 0
          && selectorCandidateCount <= 12
          && allowedCorrectionPairCount > 0
          && allowedCorrectionPairCount <= 6
        ),
        selectorCandidateCount,
        selectorInvocations,
        verifiedPairPresent
      }));
    }
    const ordinaryRaw = await retrieve(TASK_050_CORPUS.ordinary.query, false);
    const ordinaryRetained = await retrieve(TASK_050_CORPUS.ordinary.query, true);
    if (ordinaryRaw.notesUnavailable || ordinaryRetained.notesUnavailable) throw new Error("Task050 ordinary retrieval unavailable");
    const ordinary = Object.freeze({
      id: TASK_050_CORPUS.ordinary.id,
      ...assessOrdinaryTop1({
        expectedTop1: TASK_050_CORPUS.ordinary.expectedTop1,
        rawSourceIds: sourceIds(ordinaryRaw.scored, sourceForFile),
        retainedSourceIds: sourceIds(ordinaryRetained.scored, sourceForFile),
        topK: TASK_050_CORPUS.topK
      })
    });

    const headEnd = await gitHead();
    const inputEnd = await inputManifest();
    const artifact = {
      cases: [...correctionCases, ordinary],
      completedAt: new Date().toISOString(),
      corpus: {
        noteCount: TASK_050_CORPUS.notes.length,
        sha256: task050CorpusHash(),
        topK: TASK_050_CORPUS.topK,
        version: TASK_050_CORPUS.version
      },
      execution: {
        generativeRequests: 0,
        indexEmbeddingCalls,
        networkRequests: unexpectedNetworkRequests,
        nonQueryEmbeddingCalls,
        queryEmbeddingCalls,
        skipped: false,
        unavailable: false
      },
      executionStatus: "pass",
      inputs: { end: inputEnd, start: inputStart },
      schemaVersion: "muse-personal-agent-roadmap-task-050.v1",
      source: { headEnd, headStart },
      startedAt,
      summary: {
        boundedRetainedCount: TASK_050_CORPUS.topK,
        correctionCasesPassed: correctionCases.filter((item) => item.passed).length,
        correctionCasesTotal: correctionCases.length,
        ordinaryTop1Preserved: ordinary.passed
      },
      taskId: "050-A"
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
  const result = await runCorrectionPairRetentionProbe();
  process.stdout.write(`${canonicalJson({
    artifact: ".muse-dev/evals/personal-agent-roadmap/task-050.json",
    correctionCases: `${result.summary.correctionCasesPassed.toString()}/${result.summary.correctionCasesTotal.toString()}`,
    head: result.source.headEnd,
    ordinaryTop1Preserved: result.summary.ordinaryTop1Preserved,
    status: result.executionStatus
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
