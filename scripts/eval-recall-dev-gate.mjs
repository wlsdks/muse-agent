#!/usr/bin/env node

/**
 * Focused, development-only pass^3 gate for the production local-note path.
 *
 * This intentionally uses the visible frozen60 corpus. It is tuning telemetry,
 * never held-out or organic evidence. Every case runs through the CLI's default
 * reranker binding, immutable first-retrieval snapshot, and public prepare seam.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RECALL_FRESHNESS_DATASET, canonicalJson, validateDataset } from "./eval-recall-freshness-ablation.mjs";
import { spawnWithTimeout } from "./eval-recall-candidate-pool.mjs";
import { createProductionFixture } from "./eval-recall-production-path.mjs";
import {
  canonicalLoopbackBaseUrl,
  createAuditedLoopbackFetch,
  jsonBytes,
  manifestTree,
  modelInfo,
  runtimeSourceProvenance,
  sha256,
  writeAtomic
} from "./recall-eval-runtime-common.mjs";

export const DEV_GATE_SCHEMA_VERSION = "muse-recall-dev-gate.v2";
export const DEV_GATE_CHILD_SCHEMA_VERSION = "muse-recall-dev-gate-child.v2";
export const DEV_GATE_DATASET_NAMESPACE = "development-visible-v1";
export const DEV_GATE_EMBED_MODEL = "nomic-embed-text-v2-moe";
export const DEV_GATE_REPEAT = 3;
export const DEV_GATE_TOP_K = 3;
export const DEV_GATE_TIMEOUT_MS = 45 * 60_000;
export const DEV_GATE_FLOORS = Object.freeze({ absent: 20, correction: 19, ordinary: 19, overall: 58 });
export const DEV_GATE_FAILURE_CODES = Object.freeze([
  "ACTUAL_RERANKER_UNAVAILABLE",
  "CHILD_FAILED",
  "CHILD_OUTPUT_INVALID",
  "CHILD_TIMEOUT",
  "DEV_GATE_FAILED",
  "INVALID_ARGUMENTS",
  "NETWORK_ACCOUNTING_MISMATCH",
  "OWNER_STATE_CHANGED",
  "OWNER_STATE_CHECK_FAILED"
]);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const diagnosticsRoot = join(repoRoot, ".muse-dev", "evals", "recall-dev-gate");
const runtimePaths = Object.freeze([
  "packages/recall/dist/index.js",
  "packages/recall/dist/pipeline.js",
  "packages/recall/dist/ask-note-retrieval.js",
  "apps/cli/dist/ask-note-retrieval.js",
  "scripts/eval-recall-dev-gate.mjs",
  "scripts/recall-eval-runtime-common.mjs"
]);

function failure(code) {
  const error = new Error(code);
  Object.defineProperty(error, "code", { enumerable: false, value: code });
  return error;
}

export function devGateFailureCode(error) {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && DEV_GATE_FAILURE_CODES.includes(code) ? code : "DEV_GATE_FAILED";
  } catch {
    return "DEV_GATE_FAILED";
  }
}

export function formatDevGateFailure(error) {
  return `${devGateFailureCode(error)}\n`;
}

export function scoreDevRecallCase(testCase, prepared, sourceForFile) {
  const sources = prepared.scored.map((item) => sourceForFile(item.file));
  if (testCase.category === "absent") {
    const ok = prepared.verdict === "ambiguous" || prepared.verdict === "none";
    return { currentTop1: false, ok, pairRetained: false, reasonCode: ok ? null : "ABSENT_CONFIDENT" };
  }
  if (testCase.category === "ordinary-positive") {
    const ok = prepared.verdict === "confident" && sources[0] === testCase.expectedSource;
    return {
      currentTop1: false,
      ok,
      pairRetained: false,
      reasonCode: ok ? null : prepared.verdict === "confident" ? "WRONG_TOP1" : "NOT_CONFIDENT"
    };
  }
  const currentIndex = sources.indexOf(testCase.currentSource);
  const staleIndex = sources.indexOf(testCase.staleSource);
  const pairRetained = currentIndex >= 0 && staleIndex >= 0 && currentIndex < staleIndex;
  const currentTop1 = currentIndex === 0;
  const ok = pairRetained && currentTop1;
  return {
    currentTop1,
    ok,
    pairRetained,
    reasonCode: ok ? null : !pairRetained ? "PAIR_MISSING_OR_REVERSED" : "CURRENT_NOT_TOP1"
  };
}

function categoryName(category) {
  if (category === "ordinary-positive") return "ordinary";
  if (category === "correction-pair") return "correction";
  return category;
}

export function aggregateStrictPassK(trials, cases = RECALL_FRESHNESS_DATASET.cases) {
  if (!Array.isArray(trials) || trials.length !== DEV_GATE_REPEAT) throw failure("CHILD_OUTPUT_INVALID");
  const collapsed = cases.map((testCase, caseIndex) => {
    const repeats = trials.map((trial) => trial.outcomes?.[caseIndex]);
    if (repeats.some((outcome) => !outcome || outcome.caseId !== testCase.caseId || outcome.category !== testCase.category)) {
      throw failure("CHILD_OUTPUT_INVALID");
    }
    return {
      category: categoryName(testCase.category),
      currentTop1: repeats.every((outcome) => outcome.currentTop1),
      ok: repeats.every((outcome) => outcome.ok),
      pairRetained: repeats.every((outcome) => outcome.pairRetained)
    };
  });
  const count = (category, predicate = (item) => item.ok) => {
    const subset = collapsed.filter((item) => item.category === category);
    return { passed: subset.filter(predicate).length, total: subset.length };
  };
  const ordinary = count("ordinary");
  const absent = count("absent");
  const correction = count("correction");
  const correctionCurrentTop1 = count("correction", (item) => item.currentTop1);
  const correctionPairRetained = count("correction", (item) => item.pairRetained);
  const overall = { passed: collapsed.filter((item) => item.ok).length, total: collapsed.length };
  const passed = ordinary.total === 20
    && absent.total === 20
    && correction.total === 20
    && ordinary.passed >= DEV_GATE_FLOORS.ordinary
    && absent.passed >= DEV_GATE_FLOORS.absent
    && correction.passed >= DEV_GATE_FLOORS.correction
    && correctionCurrentTop1.passed >= DEV_GATE_FLOORS.correction
    && correctionPairRetained.passed >= DEV_GATE_FLOORS.correction
    && overall.passed >= DEV_GATE_FLOORS.overall;
  return { absent, correction, correctionCurrentTop1, correctionPairRetained, ordinary, overall, passed };
}

function countValues(values) {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
}

/** Aggregate-safe visible-dev telemetry: opaque case id + closed outcomes only. */
export function buildDevCaseDiagnostics(trials, cases = RECALL_FRESHNESS_DATASET.cases) {
  if (!Array.isArray(trials) || trials.length < 1) throw failure("CHILD_OUTPUT_INVALID");
  return cases.map((testCase, caseIndex) => {
    const outcomes = trials.map((trial) => trial.outcomes?.[caseIndex]);
    if (outcomes.some((outcome) => !outcome || outcome.caseId !== testCase.caseId || outcome.category !== testCase.category)) {
      throw failure("CHILD_OUTPUT_INVALID");
    }
    return {
      caseId: testCase.caseId,
      category: testCase.category,
      currentTop1Repeats: outcomes.filter((outcome) => outcome.currentTop1).length,
      decisionOutcomes: countValues(outcomes.map((outcome) => outcome.rerankDecision.outcome)),
      locale: testCase.locale,
      pairRetainedRepeats: outcomes.filter((outcome) => outcome.pairRetained).length,
      passedRepeats: outcomes.filter((outcome) => outcome.ok).length,
      reasonCodes: countValues(outcomes.map((outcome) => outcome.reasonCode ?? "PASS")),
      selectorPairKinds: countValues(outcomes.map((outcome) => outcome.selectorPairKind))
    };
  });
}

const diagnosticKeys = Object.freeze([
  "caseId",
  "category",
  "currentTop1Repeats",
  "decisionOutcomes",
  "locale",
  "pairRetainedRepeats",
  "passedRepeats",
  "reasonCodes",
  "selectorPairKinds"
]);
const decisionOutcomeKeys = Object.freeze(["absent", "empty", "error", "ineligible-window", "invalid", "success", "timeout"]);
const reasonCodeKeys = Object.freeze(["ABSENT_CONFIDENT", "CURRENT_NOT_TOP1", "NOT_CONFIDENT", "PAIR_MISSING_OR_REVERSED", "PASS", "WRONG_TOP1"]);
const selectorPairKindKeys = Object.freeze(["expected", "null", "wrong"]);

function validateClosedCountRecord(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("CHILD_OUTPUT_INVALID");
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.some((key) => !allowedKeys.includes(key))) throw failure("CHILD_OUTPUT_INVALID");
  if (keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > DEV_GATE_REPEAT)) throw failure("CHILD_OUTPUT_INVALID");
  if (keys.reduce((sum, key) => sum + value[key], 0) !== DEV_GATE_REPEAT) throw failure("CHILD_OUTPUT_INVALID");
}

/** Reject any child-controlled diagnostic field that is not part of the closed aggregate schema. */
export function validateDevCaseDiagnostics(value, cases = RECALL_FRESHNESS_DATASET.cases) {
  if (!Array.isArray(value) || value.length !== cases.length) throw failure("CHILD_OUTPUT_INVALID");
  for (let index = 0; index < cases.length; index += 1) {
    const item = value[index];
    const testCase = cases[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw failure("CHILD_OUTPUT_INVALID");
    if (canonicalJson(Object.keys(item).sort()) !== canonicalJson([...diagnosticKeys].sort())) throw failure("CHILD_OUTPUT_INVALID");
    if (item.caseId !== testCase.caseId || item.category !== testCase.category || item.locale !== testCase.locale) throw failure("CHILD_OUTPUT_INVALID");
    for (const key of ["currentTop1Repeats", "pairRetainedRepeats", "passedRepeats"]) {
      if (!Number.isSafeInteger(item[key]) || item[key] < 0 || item[key] > DEV_GATE_REPEAT) throw failure("CHILD_OUTPUT_INVALID");
    }
    validateClosedCountRecord(item.decisionOutcomes, decisionOutcomeKeys);
    validateClosedCountRecord(item.reasonCodes, reasonCodeKeys);
    validateClosedCountRecord(item.selectorPairKinds, selectorPairKindKeys);
    if ((item.reasonCodes.PASS ?? 0) !== item.passedRepeats) throw failure("CHILD_OUTPUT_INVALID");
  }
  return value;
}

const networkKeys = Object.freeze([
  "answerRequests",
  "controlRequests",
  "deniedExternalRequests",
  "embeddingRequests",
  "otherLoopbackRequests",
  "preloadRequests",
  "selectorRequests",
  "totalLoopbackRequests"
]);

export function validateDevNetworkAccounting(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...networkKeys].sort())) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  if (networkKeys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  const summed = value.answerRequests + value.controlRequests + value.embeddingRequests + value.otherLoopbackRequests + value.preloadRequests + value.selectorRequests;
  if (value.totalLoopbackRequests !== summed
    || value.answerRequests !== 0
    || value.deniedExternalRequests !== 0
    || value.otherLoopbackRequests !== 0
    || value.controlRequests !== expected.controlRequests
    || value.embeddingRequests !== expected.embeddingRequests
    || value.preloadRequests !== expected.preloadRequests
    || value.selectorRequests !== expected.selectorRequests) {
    throw failure("NETWORK_ACCOUNTING_MISMATCH");
  }
  return value;
}

function delta(after, before) {
  return Object.fromEntries(networkKeys.map((key) => [key, after[key] - before[key]]));
}

function childEnv(baseUrl, home, rerankerModel) {
  return {
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    MUSE_CLI_CONFIG_FILE: join(home, "config.json"),
    MUSE_LOCAL_ONLY: "true",
    MUSE_MODEL: `ollama/${rerankerModel}`,
    MUSE_MODEL_KEYS_FILE: join(home, "models.json"),
    OLLAMA_BASE_URL: baseUrl,
    PATH: process.env.PATH ?? "",
    TMPDIR: join(home, "tmp")
  };
}

function closedDecision(value) {
  if (!value) return { eligible: false, httpAttempts: 0, logicalInvocations: 0, outcome: "absent" };
  return {
    eligible: value.eligible === true,
    httpAttempts: value.httpAttempts,
    logicalInvocations: value.logicalInvocations,
    outcome: value.outcome
  };
}

async function executeChild({ baseUrl, home, outputPath, rerankerModel }) {
  if (!home || !process.env.TMPDIR?.startsWith(home)) throw failure("INVALID_ARGUMENTS");
  const [{ detectStaleMarker, loadIndex, prepareGroundedRecall }, { embed }, { resolveRerankModel, retrieveAndRankNotes }] = await Promise.all([
    import("../packages/recall/dist/index.js"),
    import("../apps/cli/dist/embed.js"),
    import("../apps/cli/dist/ask-note-retrieval.js")
  ]);
  validateDataset(RECALL_FRESHNESS_DATASET, detectStaleMarker);
  const runtimeEnv = Object.freeze(childEnv(baseUrl, home, rerankerModel));
  if (resolveRerankModel(runtimeEnv) !== rerankerModel) throw failure("ACTUAL_RERANKER_UNAVAILABLE");
  const audit = createAuditedLoopbackFetch(baseUrl);
  const embedFn = (text, model = DEV_GATE_EMBED_MODEL) => embed(text, model, { fetchImpl: audit.fetch }, runtimeEnv);
  const beforeModels = audit.snapshot();
  const [embedInfo, rerankInfo] = await Promise.all([
    modelInfo(baseUrl, DEV_GATE_EMBED_MODEL, audit.fetch),
    modelInfo(baseUrl, rerankerModel, audit.fetch)
  ]);
  const afterModels = audit.snapshot();
  if (afterModels.controlRequests - beforeModels.controlRequests !== 4) throw failure("NETWORK_ACCOUNTING_MISMATCH");
  const fixture = await createProductionFixture({ embed: embedFn, home, modelTag: DEV_GATE_EMBED_MODEL });
  const afterFixture = audit.snapshot();
  const index = await loadIndex(fixture.indexPath);
  if (!index || index.files.length !== 60) throw failure("CHILD_OUTPUT_INVALID");
  const trials = [];
  for (let repeat = 1; repeat <= DEV_GATE_REPEAT; repeat += 1) {
    const outcomes = [];
    for (const testCase of RECALL_FRESHNESS_DATASET.cases) {
      const before = audit.snapshot();
      const retrieval = await retrieveAndRankNotes({
        conflictAwareSelection: true,
        embedModel: DEV_GATE_EMBED_MODEL,
        indexFiles: index.files,
        json: true,
        notesDir: fixture.notesDir,
        onStderr: () => {},
        query: testCase.query,
        scope: undefined,
        snapshotIdentity: { indexBuiltAtIso: index.builtAtIso, notesIndexFile: fixture.indexPath },
        topK: DEV_GATE_TOP_K
      }, { env: runtimeEnv, fetchFn: audit.fetch });
      if (!retrieval.snapshot || retrieval.notesUnavailable) throw failure("CHILD_OUTPUT_INVALID");
      const prepared = await prepareGroundedRecall({
        embedFn,
        extras: { refineChunks: true },
        options: { conflictAwareSelection: true, embedModel: DEV_GATE_EMBED_MODEL, topK: DEV_GATE_TOP_K },
        query: testCase.query,
        rerankFn: retrieval.snapshot.rerankFn,
        retrievalSnapshot: retrieval.snapshot,
        sources: { notesDir: fixture.notesDir, notesIndexFile: fixture.indexPath }
      });
      const observed = delta(audit.snapshot(), before);
      if (observed.preloadRequests !== 1 || observed.selectorRequests > 1 || observed.controlRequests !== 0 || observed.answerRequests !== 0 || observed.otherLoopbackRequests !== 0 || observed.deniedExternalRequests !== 0) {
        throw failure("NETWORK_ACCOUNTING_MISMATCH");
      }
      const decision = closedDecision(retrieval.rerankDecision);
      if (![0, 1].includes(decision.logicalInvocations)
        || ![0, 1].includes(decision.httpAttempts)
        || decision.httpAttempts !== observed.selectorRequests
        || decision.logicalInvocations < decision.httpAttempts) {
        throw failure("NETWORK_ACCOUNTING_MISMATCH");
      }
      outcomes.push({
        ...scoreDevRecallCase(testCase, prepared, fixture.sourceForFile),
        caseId: testCase.caseId,
        category: testCase.category,
        locale: testCase.locale,
        network: { embeddingRequests: observed.embeddingRequests, preloadRequests: observed.preloadRequests, selectorRequests: observed.selectorRequests },
        rerankDecision: decision,
        selectorPairKind: retrieval.verifiedCorrectionPair === undefined
          ? "null"
          : testCase.category === "correction-pair"
            && fixture.sourceForFile(retrieval.verifiedCorrectionPair.current.file) === testCase.currentSource
            && fixture.sourceForFile(retrieval.verifiedCorrectionPair.stale.file) === testCase.staleSource
              ? "expected"
              : "wrong"
      });
    }
    trials.push({ outcomes, repeat });
  }
  const finalNetwork = audit.snapshot();
  const expected = {
    controlRequests: afterModels.controlRequests - beforeModels.controlRequests,
    embeddingRequests: afterFixture.embeddingRequests + trials.flatMap((trial) => trial.outcomes).reduce((sum, item) => sum + item.network.embeddingRequests, 0),
    preloadRequests: trials.flatMap((trial) => trial.outcomes).reduce((sum, item) => sum + item.network.preloadRequests, 0),
    selectorRequests: trials.flatMap((trial) => trial.outcomes).reduce((sum, item) => sum + item.network.selectorRequests, 0)
  };
  validateDevNetworkAccounting(finalNetwork, expected);
  const quality = aggregateStrictPassK(trials);
  const result = {
    dataset: { cases: RECALL_FRESHNESS_DATASET.cases.length, namespace: DEV_GATE_DATASET_NAMESPACE },
    developmentDiagnostics: buildDevCaseDiagnostics(trials),
    embedder: { ...embedInfo, modelTag: DEV_GATE_EMBED_MODEL },
    network: finalNetwork,
    quality,
    repeats: DEV_GATE_REPEAT,
    reranker: { ...rerankInfo, modelTag: rerankerModel },
    schemaVersion: DEV_GATE_CHILD_SCHEMA_VERSION,
    trialHashes: trials.map((trial) => sha256(jsonBytes(trial.outcomes.map(({ caseId, category, currentTop1, ok, pairRetained, reasonCode }) => ({ caseId, category, currentTop1, ok, pairRetained, reasonCode })))))
  };
  await writeAtomic(outputPath, jsonBytes(result));
}

function parseInternalArgs(args) {
  const output = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw failure("INVALID_ARGUMENTS");
    output[args[index].slice(2)] = args[index + 1];
  }
  return output;
}

export function validateDevGateChild(value, rerankerModel) {
  if (!value || value.schemaVersion !== DEV_GATE_CHILD_SCHEMA_VERSION || value.repeats !== DEV_GATE_REPEAT) throw failure("CHILD_OUTPUT_INVALID");
  if (value.dataset?.namespace !== DEV_GATE_DATASET_NAMESPACE || value.dataset.cases !== 60) throw failure("CHILD_OUTPUT_INVALID");
  if (value.embedder?.modelTag !== DEV_GATE_EMBED_MODEL || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.embedder.digest)) throw failure("CHILD_OUTPUT_INVALID");
  if (value.reranker?.modelTag !== rerankerModel || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.reranker.digest)) throw failure("CHILD_OUTPUT_INVALID");
  if (!Array.isArray(value.trialHashes) || value.trialHashes.length !== DEV_GATE_REPEAT || value.trialHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) throw failure("CHILD_OUTPUT_INVALID");
  if (!value.quality || value.quality.overall?.total !== 60) throw failure("CHILD_OUTPUT_INVALID");
  validateDevCaseDiagnostics(value.developmentDiagnostics);
  validateDevNetworkAccounting(value.network, {
    controlRequests: 4,
    embeddingRequests: value.network.embeddingRequests,
    preloadRequests: 60 * DEV_GATE_REPEAT,
    selectorRequests: value.network.selectorRequests
  });
  return value;
}

async function parentMain() {
  const { resolveRerankModel } = await import("../apps/cli/dist/ask-note-retrieval.js");
  const rerankerModel = resolveRerankModel(process.env);
  if (!rerankerModel) throw failure("ACTUAL_RERANKER_UNAVAILABLE");
  const baseUrl = canonicalLoopbackBaseUrl(process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434");
  const sessionName = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const sessionDir = join(diagnosticsRoot, sessionName);
  const home = join(sessionDir, "home");
  const outputPath = join(sessionDir, "child.json");
  await mkdir(join(home, "tmp"), { mode: 0o700, recursive: true });
  const ownerRoot = join(homedir(), ".muse");
  let before;
  let childResult;
  let operationError;
  let ownerState;
  try {
    before = await manifestTree(ownerRoot);
    const child = await spawnWithTimeout(
      process.execPath,
      [fileURLToPath(import.meta.url), "--child", "1", "--base", baseUrl, "--home", home, "--out", outputPath, "--reranker", rerankerModel],
      { env: childEnv(baseUrl, home, rerankerModel), outputPath, timeoutMs: DEV_GATE_TIMEOUT_MS }
    );
    if (!child.ok) throw failure(child.reasonCode === "TIMEOUT" ? "CHILD_TIMEOUT" : "CHILD_FAILED");
    try {
      childResult = validateDevGateChild(JSON.parse(await readFile(outputPath, "utf8")), rerankerModel);
    } catch {
      throw failure("CHILD_OUTPUT_INVALID");
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      const after = await manifestTree(ownerRoot);
      ownerState = { afterSha256: after.manifestSha256, beforeSha256: before?.manifestSha256, unchanged: before !== undefined && before.manifestSha256 === after.manifestSha256 };
      if (!ownerState.unchanged) operationError = failure("OWNER_STATE_CHANGED");
    } catch {
      operationError = failure("OWNER_STATE_CHECK_FAILED");
    }
    await rm(home, { force: true, recursive: true }).catch(() => {});
  }
  if (operationError) throw operationError;
  const runtimeSources = await runtimeSourceProvenance(repoRoot, runtimePaths);
  const result = {
    payload: {
      dataset: childResult.dataset,
      developmentDiagnostics: childResult.developmentDiagnostics,
      embedder: childResult.embedder,
      network: childResult.network,
      organicEvidence: false,
      ownerState,
      qualification: "DEVELOPMENT_ONLY",
      quality: childResult.quality,
      repeats: childResult.repeats,
      reranker: childResult.reranker,
      runtimeSources,
      trialHashes: childResult.trialHashes
    },
    schemaVersion: DEV_GATE_SCHEMA_VERSION,
    status: childResult.quality.passed ? "PASS" : "FAIL"
  };
  await writeAtomic(join(sessionDir, "result.json"), jsonBytes(result));
  process.stdout.write(`${canonicalJson({
    artifact: join(".muse-dev", "evals", "recall-dev-gate", sessionName, "result.json"),
    quality: result.payload.quality,
    status: result.status
  })}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  if (args[0] === "--child") {
    const options = parseInternalArgs(args.slice(2));
    if (!options.base || !options.home || !options.out || !options.reranker) throw failure("INVALID_ARGUMENTS");
    await executeChild({ baseUrl: canonicalLoopbackBaseUrl(options.base), home: options.home, outputPath: options.out, rerankerModel: options.reranker });
    return;
  }
  if (args.length !== 0) throw failure("INVALID_ARGUMENTS");
  await parentMain();
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(formatDevGateFailure(error));
    process.exitCode = 1;
  });
}
