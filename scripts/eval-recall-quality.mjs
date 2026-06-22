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
  // KO facts
  { source: "fact:home_city", text: "지금 내가 사는 도시는 부산이다." },
  { source: "fact:home_city_old", text: "예전에는 서울에 살았었다. 지금은 아니다." },
  { source: "fact:dietary", text: "나는 유당불내증이라 우유를 못 마신다." },
  { source: "fact:car", text: "내 차는 2019년식 회색 아반떼다." },
  { source: "fact:job", text: "나는 백엔드 개발자로 일한다." },
  { source: "fact:apt_floor", text: "우리 집은 아파트 12층이다." },
  { source: "fact:allergy", text: "나는 땅콩 알레르기가 있다." },
  // KO preferences
  { source: "pref:coffee", text: "커피는 아메리카노보다 라떼를 더 좋아한다." },
  { source: "pref:music", text: "잔잔한 재즈를 즐겨 듣는다." },
  { source: "pref:season", text: "사계절 중 가을을 제일 좋아한다." },
  // KO goals
  { source: "goal:running", text: "올해 목표는 10km 마라톤을 완주하는 것이다." },
  { source: "goal:reading", text: "한 달에 책 두 권 읽기가 목표다." },
  // EN facts / prefs / goal
  { source: "fact:dentist", text: "My dentist is Dr. Cho at Smile Clinic." },
  { source: "fact:laptop", text: "My work laptop is a 14-inch MacBook Pro." },
  { source: "pref:tea", text: "I prefer green tea over black tea." },
  { source: "goal:spanish", text: "My goal this year is to reach B1 in Spanish." },
  // EN correction pair (current vs stale)
  { source: "fact:gym", text: "I now go to the gym near my office every morning." },
  { source: "fact:gym_old", text: "I used to work out at a home gym, but not anymore." },
  // distractors — unrelated personal facts that must not be recalled as answers
  { source: "d:standup", text: "팀 스탠드업은 매일 아침 9시 30분." },
  { source: "d:budget", text: "한 달 장보기 예산은 60만 원이다." },
  { source: "d:weekend", text: "주말마다 등산을 간다. 다음 목표는 설악산." },
  { source: "d:commute", text: "I commute by subway, line 2." }
];

/**
 * Each case: a recall question. `expectedSource` = the memory entry a faithful
 * recall must surface as the TOP match (positive); `expectedSource: null` = an
 * absent fact where the only correct behavior is to ABSTAIN (confidence not
 * "confident"), never to dress a weak match up as a recalled fact.
 */
export const RECALL_QUALITY_CASES = [
  // positives — KO facts
  { note: "fact: car", query: "내가 어떤 차 탄다고 했지?", expectedSource: "fact:car" },
  { note: "fact: dietary", query: "내가 못 마시는 거 뭐였지?", expectedSource: "fact:dietary" },
  { note: "fact: job", query: "내 직업이 뭐라고 했더라?", expectedSource: "fact:job" },
  { note: "fact: apt floor", query: "우리 집 몇 층이라고 했지?", expectedSource: "fact:apt_floor" },
  { note: "fact: allergy", query: "나 무슨 알레르기 있다고 했어?", expectedSource: "fact:allergy" },
  // positives — KO preferences
  { note: "pref: coffee", query: "나 커피 뭐 좋아한다고 했어?", expectedSource: "pref:coffee" },
  { note: "pref: music", query: "내가 무슨 음악 즐겨 듣는다고 했지?", expectedSource: "pref:music" },
  { note: "pref: season", query: "내가 제일 좋아하는 계절이 뭐였지?", expectedSource: "pref:season" },
  // positives — KO goals
  { note: "goal: running", query: "내 올해 운동 목표가 뭐였지?", expectedSource: "goal:running" },
  { note: "goal: reading", query: "내가 한 달에 책 몇 권 읽기로 했더라?", expectedSource: "goal:reading" },
  // positives — KO correction (current value wins)
  { note: "correction — current city wins", query: "나 지금 어디 산다고 했지?", expectedSource: "fact:home_city" },
  // positives — EN
  { note: "fact: dentist (EN)", query: "who is my dentist?", expectedSource: "fact:dentist" },
  { note: "fact: laptop (EN)", query: "what laptop do I use for work?", expectedSource: "fact:laptop" },
  { note: "pref: tea (EN)", query: "what tea do I prefer?", expectedSource: "pref:tea" },
  { note: "goal: spanish (EN)", query: "what's my language goal this year?", expectedSource: "goal:spanish" },
  { note: "correction — current gym wins (EN)", query: "where do I work out now?", expectedSource: "fact:gym" },
  // absents — must abstain (never fabricate)
  { note: "absent: blood type", query: "내 혈액형이 뭐라고 했지?", expectedSource: null },
  { note: "absent: pet name", query: "내가 키우는 반려동물 이름 뭐였지?", expectedSource: null },
  { note: "absent: siblings", query: "나 형제자매 몇 명이라고 했지?", expectedSource: null },
  { note: "absent: birthday", query: "내 생일이 언제라고 했더라?", expectedSource: null },
  { note: "absent: company name", query: "내가 다니는 회사 이름이 뭐였지?", expectedSource: null },
  { note: "absent: shoe size (EN)", query: "what's my shoe size?", expectedSource: null },
  { note: "absent: favorite movie (EN)", query: "what's my favorite movie?", expectedSource: null },
  { note: "absent: middle name (EN)", query: "what's my middle name?", expectedSource: null }
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

/**
 * hit@1 (RETRIEVAL correctness, independent of the confidence gate): did the
 * RIGHT entry rank top-1, regardless of whether the gate then chose to present
 * it? Only meaningful for positive cases (the ranker always returns a top match,
 * so an absent case has no "right entry" to hit). Separating this from
 * `scoreRecallQualityCase` (which requires `confident`) is what tells a retrieval
 * miss apart from pure under-confidence — the diagnostic the 43% baseline needs.
 * @param {{topSource?:string|null}} observed
 * @param {{expectedSource:string|null}} testCase
 * @returns {{ok:boolean, applicable:boolean, detail:string}}
 */
export function scoreRecallHit1(observed, testCase) {
  if (testCase.expectedSource === null) {
    return { ok: false, applicable: false, detail: "n/a — absent case has no expected entry" };
  }
  const ok = (observed?.topSource ?? null) === testCase.expectedSource;
  return { ok, applicable: true, detail: ok ? `top-1 = ${testCase.expectedSource}` : `top-1 = ${observed?.topSource ?? null}` };
}

/**
 * Classify a POSITIVE case's outcome into the triad that pinpoints the fix:
 * - "confident-correct": the gate confidently recalled the right entry (good).
 * - "under-confidence":  the right entry IS top-1 but the gate abstained — the
 *                        cosine bar is too high for short memory entries
 *                        (recalibration territory, NOT a retrieval failure).
 * - "wrong-entry":       a different entry ranked top-1 (a real retrieval miss).
 * - "confident-wrong":   the gate confidently recalled the WRONG entry (worst).
 * Returns null for absent cases (not part of the retrieval triad).
 * @param {{confidence:string, topSource?:string|null}} observed
 * @param {{expectedSource:string|null}} testCase
 */
export function classifyRecallOutcome(observed, testCase) {
  if (testCase.expectedSource === null) return null;
  const rightTop = (observed?.topSource ?? null) === testCase.expectedSource;
  if (observed?.confidence === "confident") return rightTop ? "confident-correct" : "confident-wrong";
  return rightTop ? "under-confidence" : "wrong-entry";
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
    // the memory-recall path opts in to margin promotion (notes/proactive/council
    // keep the default OFF behavior); this is the calibration evidence for wiring
    // promoteOnMargin into the production memory-recall call site (fire 3b follow-up).
    const confidence = classifyRetrievalConfidence(matches, { promoteOnMargin: true });
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

  // DIAGNOSTIC (not a gate): split RETRIEVAL hit@1 from the CONFIDENCE gate so a
  // recall miss is attributable. A positive that abstained with the right entry
  // top-1 is under-confidence (recalibrate); a wrong top-1 is a retrieval miss.
  const positives = RECALL_QUALITY_CASES.filter((c) => c.expectedSource !== null);
  const tally = { "confident-correct": 0, "under-confidence": 0, "wrong-entry": 0, "confident-wrong": 0 };
  let hit1 = 0;
  for (const testCase of positives) {
    const observed = await solve(testCase);
    if (scoreRecallHit1(observed, testCase).ok) hit1 += 1;
    const outcome = classifyRecallOutcome(observed, testCase);
    if (outcome) tally[outcome] += 1;
  }
  console.log(`\n--- diagnostic (positives only, n=${positives.length}) ---`);
  console.log(`  retrieval hit@1 = ${hit1}/${positives.length}   (right entry ranked top-1, ignoring the confidence gate)`);
  console.log(`  outcome triad   : confident-correct ${tally["confident-correct"]} · under-confidence ${tally["under-confidence"]} · wrong-entry ${tally["wrong-entry"]} · confident-wrong ${tally["confident-wrong"]}`);
  console.log(
    tally["under-confidence"] >= tally["wrong-entry"]
      ? `  → dominant gap is UNDER-CONFIDENCE: retrieval finds the entry; the cosine bar is too high for short memory entries (recalibration territory, fabrication-floor-sensitive).`
      : `  → dominant gap is RETRIEVAL: the wrong entry ranks top-1 (ranker/embedding territory, not the gate).`
  );

  process.exit(gate ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
