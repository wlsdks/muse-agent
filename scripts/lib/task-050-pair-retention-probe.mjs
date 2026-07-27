import {
  canonicalJson,
  sha256
} from "./task-049-corrected-fact-probe.mjs";

const editorPair = Object.freeze(["editor-old", "editor-current"]);
const commutePair = Object.freeze(["commute-old", "commute-current"]);

export const TASK_050_CORPUS = Object.freeze({
  cases: Object.freeze([
    Object.freeze({
      currentSourceId: editorPair[1],
      id: "editor",
      oldSourceId: editorPair[0],
      query: "What is my current editor for coding?",
      queryVector: Object.freeze([1, 0, 0])
    }),
    Object.freeze({
      currentSourceId: commutePair[1],
      id: "commute",
      oldSourceId: commutePair[0],
      query: "How do I currently commute to the office?",
      queryVector: Object.freeze([0, 1, 0])
    })
  ]),
  embedModel: "task-050-fixed-vectors-v1",
  notes: Object.freeze([
    Object.freeze({ sourceId: editorPair[0], text: "I used to use Atom editor for coding; no longer current.", vector: Object.freeze([1, 0, 0]) }),
    Object.freeze({ sourceId: editorPair[1], text: "Correction: I currently use Zed editor for coding, replacing Atom.", vector: Object.freeze([0.95, 0.3122498999199199, 0]) }),
    Object.freeze({ sourceId: "editor-noise-1", text: "The release checklist includes reviewing package notes.", vector: Object.freeze([0.99, 0.14106735979665894, 0]) }),
    Object.freeze({ sourceId: "editor-noise-2", text: "The calendar has a planning block on Friday.", vector: Object.freeze([0.98, 0.1989974874213242, 0]) }),
    Object.freeze({ sourceId: commutePair[0], text: "I used to commute by bus to the office; no longer current.", vector: Object.freeze([0, 1, 0]) }),
    Object.freeze({ sourceId: commutePair[1], text: "Correction: I currently commute by train to the office, replacing bus.", vector: Object.freeze([0.3122498999199199, 0.95, 0]) }),
    Object.freeze({ sourceId: "commute-noise-1", text: "The finance worksheet contains quarterly totals.", vector: Object.freeze([0.14106735979665894, 0.99, 0]) }),
    Object.freeze({ sourceId: "commute-noise-2", text: "The meeting agenda includes a project retrospective.", vector: Object.freeze([0.1989974874213242, 0.98, 0]) }),
    Object.freeze({ sourceId: "ordinary-laptop", text: "My work laptop is a 14-inch MacBook Pro.", vector: Object.freeze([0, 0, 1]) })
  ]),
  ordinary: Object.freeze({
    expectedTop1: "ordinary-laptop",
    id: "ordinary-laptop",
    query: "What laptop do I use for work?",
    queryVector: Object.freeze([0, 0, 1])
  }),
  topK: 3,
  version: "muse-task-050-pair-retention.v1"
});

export function task050CorpusHash() {
  return sha256(`${canonicalJson(TASK_050_CORPUS)}\n`);
}

function exactUniqueIds(value, label) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw new TypeError(`invalid ${label} identities`);
  }
  return value;
}

export function assessCorrectionPairRetention({
  currentSourceId,
  oldSourceId,
  preMmrSourceIds,
  retainedSourceIds,
  topK
}) {
  const preMmr = exactUniqueIds(preMmrSourceIds, "pre-MMR");
  const retained = exactUniqueIds(retainedSourceIds, "retained");
  if (
    typeof currentSourceId !== "string"
    || typeof oldSourceId !== "string"
    || currentSourceId === oldSourceId
    || !Number.isSafeInteger(topK)
    || topK < 2
    || preMmr.length !== topK
    || retained.length !== topK
  ) {
    throw new TypeError("invalid correction-pair retention evidence");
  }
  const additions = retained.filter((sourceId) => !preMmr.includes(sourceId));
  const retainedPairPresent = (
    retained.includes(oldSourceId)
    && retained.includes(currentSourceId)
  );
  const passed = (
    preMmr.includes(oldSourceId)
    && !preMmr.includes(currentSourceId)
    && retainedPairPresent
    && additions.length === 1
    && additions[0] === currentSourceId
  );
  return Object.freeze({
    addedCounterpartCount: additions.length,
    addedSourceIds: Object.freeze([...additions]),
    currentSourceId,
    oldSourceId,
    passed,
    preMmrCurrentPresent: preMmr.includes(currentSourceId),
    preMmrPairPresent: preMmr.includes(oldSourceId) && preMmr.includes(currentSourceId),
    preMmrSourceIds: Object.freeze([...preMmr]),
    retainedCount: retained.length,
    retainedPairPresent,
    retainedSourceIds: Object.freeze([...retained])
  });
}

export function assessOrdinaryTop1({
  expectedTop1,
  rawSourceIds,
  retainedSourceIds,
  topK
}) {
  const raw = exactUniqueIds(rawSourceIds, "ordinary raw");
  const retained = exactUniqueIds(retainedSourceIds, "ordinary retained");
  if (
    typeof expectedTop1 !== "string"
    || expectedTop1.length === 0
    || !Number.isSafeInteger(topK)
    || topK < 1
    || raw.length < 1
    || raw.length > topK
    || retained.length < 1
    || retained.length > topK
  ) {
    throw new TypeError("invalid ordinary retention evidence");
  }
  return Object.freeze({
    expectedTop1,
    passed: raw[0] === expectedTop1 && retained[0] === expectedTop1,
    rawTop1: raw[0],
    retainedCount: retained.length,
    retainedTop1: retained[0]
  });
}
