/**
 * eval:recall-quality — golden-set measurement of Muse's PERSONAL-MEMORY recall
 * (the "기억/회상 비서" golden path). Distinct from the notes batteries
 * (verify-cited-recall / verify-multihop, which use a knowledge-CHUNK corpus):
 * this models the USER's own facts/preferences/goals and asks the questions a
 * memory assistant actually gets — "내 X 뭐였지?", an absent fact (must abstain,
 * never fabricate), and a CORRECTED fact where the CURRENT value must win over
 * the stale one (the identity's "FORGETS the moment you correct it", measured).
 *
 * Drives the PRODUCTION retrieval + confidence gate (rankKnowledgeChunks →
 * classifyRetrievalConfidence) on REAL local embeddings — NOT a fake registry.
 * The deterministic SCORER (`scoreRecallQualityCase`) is the teeth and is unit-
 * tested zero-dep in eval-recall-quality.test.mjs, so the gate has teeth even on
 * a box where Ollama is down (a skip is NOT a pass).
 *
 *   node scripts/eval-recall-quality.mjs               (nomic embed default)
 *   MUSE_EVAL_REPEAT=5 node scripts/eval-recall-quality.mjs   (pass^k)
 *
 * Exit 0 + PASS if rate ≥ threshold; exit 1 on a real regression; skip (exit 0)
 * if Ollama / the embed model is unreachable. LOCAL OLLAMA ONLY.
 */
import { pathToFileURL } from "node:url";

import { runEvalSuite } from "./eval-harness.mjs";

/**
 * The user's OWN memory, rendered as sourced entries (what a memory store holds:
 * facts, a preference, a goal). The CORRECTION pair (home city) carries the
 * stale value as a PAST-tense entry and the current value as a present-tense
 * entry — a faithful recall must surface the current one, not the stale one.
 */
export const RECALL_MEMORY_CORPUS = [
  { source: "fact:home_city", text: "지금 내가 사는 도시는 부산이다." },
  { source: "fact:home_city_old", text: "예전에는 서울에 살았었다. 지금은 아니다." },
  { source: "fact:dietary", text: "나는 유당불내증이라 우유를 못 마신다." },
  { source: "pref:coffee", text: "커피는 아메리카노보다 라떼를 더 좋아한다." },
  { source: "goal:running", text: "올해 목표는 10km 마라톤을 완주하는 것이다." },
  { source: "fact:car", text: "내 차는 2019년식 회색 아반떼다." },
  // distractors — unrelated personal facts that must not be recalled as answers
  { source: "d:standup", text: "팀 스탠드업은 매일 아침 9시 30분." },
  { source: "d:budget", text: "한 달 장보기 예산은 60만 원이다." }
];

/**
 * Each case: a recall question. `expectedSource` = the memory entry a faithful
 * recall must surface as the TOP match (positive); `expectedSource: null` = an
 * absent fact where the only correct behavior is to ABSTAIN (confidence not
 * "confident"), never to dress a weak match up as a recalled fact.
 */
export const RECALL_QUALITY_CASES = [
  { note: "direct fact", query: "내가 어떤 차 탄다고 했지?", expectedSource: "fact:car" },
  { note: "dietary fact", query: "내가 못 마시는 거 뭐였지?", expectedSource: "fact:dietary" },
  { note: "preference", query: "나 커피 뭐 좋아한다고 했어?", expectedSource: "pref:coffee" },
  { note: "goal", query: "내 올해 목표가 뭐였지?", expectedSource: "goal:running" },
  { note: "correction — current value wins", query: "나 지금 어디 산다고 했지?", expectedSource: "fact:home_city" },
  { note: "absent — must abstain", query: "내 혈액형이 뭐라고 했지?", expectedSource: null },
  { note: "absent — must abstain", query: "내가 키우는 반려동물 이름 뭐였지?", expectedSource: null }
];

/**
 * Deterministic scorer (the teeth). `observed` = { confidence, topSource }.
 * - positive case: PASS iff the gate is "confident" AND the top match is the
 *   expected entry (a confident recall of the WRONG entry FAILS; abstaining on a
 *   present fact FAILS).
 * - absent case: PASS iff the gate ABSTAINS ("ambiguous"|"none"); a "confident"
 *   verdict on an absent fact is a fabrication risk and FAILS.
 * @param {{confidence:"confident"|"ambiguous"|"none", topSource?:string|null}} observed
 * @param {{expectedSource:string|null, note?:string}} testCase
 * @returns {{ok:boolean, detail:string}}
 */
export function scoreRecallQualityCase(observed, testCase) {
  const conf = observed?.confidence;
  const top = observed?.topSource ?? null;
  if (testCase.expectedSource === null) {
    const ok = conf === "ambiguous" || conf === "none";
    return { ok, detail: ok ? `abstained (${conf})` : `did NOT abstain — confidence=${conf}, top=${top}` };
  }
  if (conf !== "confident") {
    return { ok: false, detail: `expected confident recall of ${testCase.expectedSource}, got ${conf}` };
  }
  const ok = top === testCase.expectedSource;
  return { ok, detail: ok ? `recalled ${top}` : `recalled WRONG entry ${top}, expected ${testCase.expectedSource}` };
}

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");

async function reachable() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3_000);
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await reachable())) {
    console.log(`eval:recall-quality skipped — local Ollama not reachable at ${OLLAMA_BASE}. A skip is NOT a pass.`);
    process.exit(0);
  }

  const { rankKnowledgeChunks, classifyRetrievalConfidence } = await import("../packages/agent-core/dist/index.js");
  const { createOllamaEmbedder } = await import("../packages/autoconfigure/dist/index.js");
  const { DEFAULT_EMBED_MODEL } = await import("../apps/cli/dist/embed-model-default.js");

  const embed = createOllamaEmbedder(process.argv[2] ?? DEFAULT_EMBED_MODEL);
  try {
    await embed("probe");
  } catch (cause) {
    console.log(`eval:recall-quality skipped — embedder unavailable (${cause instanceof Error ? cause.message : String(cause)}).`);
    process.exit(0);
  }

  const repeat = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT) || 1));
  const topK = 4;

  const solve = async (testCase) => {
    const matches = await rankKnowledgeChunks(testCase.query, RECALL_MEMORY_CORPUS, {
      diversify: true,
      embed,
      hybrid: true,
      topK
    });
    const confidence = classifyRetrievalConfidence(matches);
    return { confidence, topSource: matches[0]?.source ?? null };
  };

  const { gate } = await runEvalSuite({
    name: "eval:recall-quality",
    scenarios: [{ label: "personal-memory recall", cases: RECALL_QUALITY_CASES }],
    solve,
    score: scoreRecallQualityCase,
    repeat,
    threshold: 0.85
  });
  process.exit(gate ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
