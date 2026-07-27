import { createHash } from "node:crypto";

const STAGE_NAMES = Object.freeze(["candidate", "rank", "policy"]);
const VERDICTS = new Set(["ambiguous", "confident", "none"]);

export const TASK_049_CORPUS = Object.freeze({
  currentSourceId: "current-fact",
  embedModel: "task-049-fixed-vectors-v1",
  notes: Object.freeze([
    Object.freeze({
      sourceId: "old-fact",
      text: "My preferred editor is Vim.",
      vector: Object.freeze([1, 0, 0])
    }),
    Object.freeze({
      sourceId: "current-fact",
      text: "Correction: my current preferred editor is Zed, replacing Vim.",
      vector: Object.freeze([0.98, 0.1989974874213242, 0])
    }),
    Object.freeze({
      sourceId: "distractor",
      text: "The launch checklist includes reviewing release notes.",
      vector: Object.freeze([0, 1, 0])
    })
  ]),
  oldSourceId: "old-fact",
  query: "What is my current preferred editor?",
  queryVector: Object.freeze([1, 0, 0]),
  topK: 3,
  version: "muse-task-049-corrected-fact-corpus.v1"
});

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function task049CorpusHash() {
  return sha256(`${canonicalJson(TASK_049_CORPUS)}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function projectScoredStage(scored, sourceForFile) {
  if (!Array.isArray(scored) || typeof sourceForFile !== "function") {
    throw new TypeError("invalid corrected-fact scored stage");
  }
  return scored.map((item) => {
    const sourceId = sourceForFile(item?.file);
    const chunkIndex = item?.chunk?.chunkIndex;
    if (
      typeof sourceId !== "string"
      || sourceId.length === 0
      || !Number.isSafeInteger(chunkIndex)
      || chunkIndex < 0
    ) {
      throw new TypeError("invalid corrected-fact scored stage");
    }
    return Object.freeze({
      opaqueId: sha256(`${sourceId}\0${chunkIndex}`),
      sourceId
    });
  });
}

function assertValidStageEvidence(input) {
  if (
    !isRecord(input)
    || typeof input.oldSourceId !== "string"
    || input.oldSourceId.length === 0
    || typeof input.currentSourceId !== "string"
    || input.currentSourceId.length === 0
    || input.oldSourceId === input.currentSourceId
    || !isRecord(input.stages)
    || !VERDICTS.has(input.verdict)
  ) {
    throw new TypeError("invalid corrected-fact stage evidence");
  }

  const opaqueToSource = new Map();
  const sourceToOpaque = new Map();
  for (const stageName of STAGE_NAMES) {
    const entries = input.stages[stageName];
    if (!Array.isArray(entries)) {
      throw new TypeError("invalid corrected-fact stage evidence");
    }

    const stageOpaqueIds = new Set();
    const stageSourceIds = new Set();
    for (const entry of entries) {
      if (
        !isRecord(entry)
        || Object.keys(entry).sort().join(",") !== "opaqueId,sourceId"
        || typeof entry.opaqueId !== "string"
        || entry.opaqueId.length === 0
        || typeof entry.sourceId !== "string"
        || entry.sourceId.length === 0
      ) {
        throw new TypeError("invalid corrected-fact stage evidence");
      }
      if (
        stageOpaqueIds.has(entry.opaqueId)
        || stageSourceIds.has(entry.sourceId)
        || (
          opaqueToSource.has(entry.opaqueId)
          && opaqueToSource.get(entry.opaqueId) !== entry.sourceId
        )
        || (
          sourceToOpaque.has(entry.sourceId)
          && sourceToOpaque.get(entry.sourceId) !== entry.opaqueId
        )
      ) {
        throw new TypeError("duplicate corrected-fact stage identity");
      }
      stageOpaqueIds.add(entry.opaqueId);
      stageSourceIds.add(entry.sourceId);
      opaqueToSource.set(entry.opaqueId, entry.sourceId);
      sourceToOpaque.set(entry.sourceId, entry.opaqueId);
    }
  }
}

export function classifyCorrectedFactStages(input) {
  assertValidStageEvidence(input);
  const candidates = new Set(input.stages.candidate.map((entry) => entry.sourceId));
  if (!candidates.has(input.oldSourceId) || !candidates.has(input.currentSourceId)) {
    return "candidate_pair_missing";
  }
  if (input.stages.rank[0]?.sourceId !== input.currentSourceId) {
    return "rank_current_not_top1";
  }
  if (input.stages.policy[0]?.sourceId !== input.currentSourceId) {
    return "policy_current_not_top1";
  }
  return "pass";
}
