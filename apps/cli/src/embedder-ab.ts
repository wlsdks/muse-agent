import type { KnowledgeMatch } from "@muse/agent-core";

/**
 * Retrieval A/B corpus for the embedder-default decision. Queries deliberately
 * PARAPHRASE their note (와이파이→인터넷, 갱신→다시 가입) — a lexically identical
 * query cannot discriminate between embedders because the hybrid ranker's
 * lexical arm answers it. KO majority (the user's language) + EN controls so a
 * multilingual candidate must win Korean WITHOUT regressing English.
 */
export interface EmbedderAbCase {
  readonly query: string;
  readonly expectedSource: string;
}

export interface EmbedderAbCorpus {
  readonly notes: ReadonlyArray<{ readonly source: string; readonly text: string }>;
  readonly cases: readonly EmbedderAbCase[];
}

export const EMBEDDER_AB_CORPUS: EmbedderAbCorpus = {
  cases: [
    { expectedSource: "wifi.md", query: "회사 인터넷 암호가 뭐였지?" },
    { expectedSource: "insurance.md", query: "보험 다시 가입해야 하는 날짜 언제야?" },
    { expectedSource: "workout.md", query: "운동 스케줄이 어떻게 되더라?" },
    { expectedSource: "deadline.md", query: "베타 언제까지 내보내야 해?" },
    { expectedSource: "dentist.md", query: "스케일링 받으러 어디로 전화하지?" },
    { expectedSource: "trip.md", query: "일본 가는 일정 알려줘" },
    { expectedSource: "vitamins.md", query: "아침에 챙겨 먹는 영양제 뭐지?" },
    { expectedSource: "reading.md", query: "자기 전에 뭐 읽고 있었지?" },
    { expectedSource: "car.md", query: "엔진오일 언제 갈았더라?" },
    { expectedSource: "coffee.md", query: "내가 좋아하는 커피 콩 뭐야?" },
    { expectedSource: "landlord.md", query: "전세 끝나는 게 언제야?" },
    { expectedSource: "piano.md", query: "피아노 수업 무슨 요일이야?" },
    { expectedSource: "landlord.md", query: "when is my lease ending?" },
    { expectedSource: "standup.md", query: "what time is the daily sync?" },
    { expectedSource: "budget.md", query: "how much do I spend on food each month?" }
  ],
  notes: [
    { source: "wifi.md", text: "사무실 와이파이 비밀번호는 muse2026입니다. 공유기는 회의실 천장에 있습니다." },
    { source: "insurance.md", text: "실비보험 갱신일은 매년 3월 14일이고 보험사는 한화생명이다." },
    { source: "workout.md", text: "월수금 아침 7시에 한강에서 러닝을 한다. 목표는 10km 50분." },
    { source: "deadline.md", text: "사이드 프로젝트 베타 출시 마감은 7월 15일." },
    { source: "dentist.md", text: "치과 예약은 강남미소치과, 02-555-1234. 6개월마다 스케일링." },
    { source: "trip.md", text: "오사카 여행은 9월 20일부터 23일까지, 숙소는 난바역 근처." },
    { source: "vitamins.md", text: "아침마다 오메가3와 비타민D를 먹는다. 비타민D는 5000IU." },
    { source: "reading.md", text: "요즘 읽는 책은 '사피엔스'. 매일 자기 전 30분씩 읽는다." },
    { source: "car.md", text: "차 엔진오일은 작년 11월에 갈았다. 다음 교체는 만 킬로미터 더 타고 나서." },
    { source: "coffee.md", text: "원두는 에티오피아 예가체프를 가장 좋아한다. 분쇄도는 중간." },
    { source: "landlord.md", text: "집주인 연락처는 010-9876-5432. 전세 계약 만기는 내년 2월 말." },
    { source: "piano.md", text: "피아노 레슨은 매주 화요일 저녁 8시, 선생님은 김선생님." },
    { source: "standup.md", text: "Team standup is every weekday at 9:30 am on Zoom." },
    { source: "budget.md", text: "Monthly grocery budget is 600,000 won, tracked in the shared sheet." }
  ]
};

export interface RetrievalRecallResult {
  readonly total: number;
  /** Expected source ranked first. */
  readonly hit1: number;
  /** Expected source anywhere in the returned top-K. */
  readonly hitK: number;
  readonly misses: readonly string[];
}

/** Pure retrieval scorer — rank is injected, so tests stub it and the live script wires real embeddings. */
export async function scoreRetrievalRecall(
  cases: readonly EmbedderAbCase[],
  rank: (query: string) => Promise<readonly KnowledgeMatch[]>
): Promise<RetrievalRecallResult> {
  let hit1 = 0;
  let hitK = 0;
  const misses: string[] = [];
  for (const testCase of cases) {
    const matches = await rank(testCase.query);
    const sources = matches.map((match) => match.source);
    if (sources[0] === testCase.expectedSource) hit1 += 1;
    if (sources.includes(testCase.expectedSource)) {
      hitK += 1;
    } else {
      misses.push(`${testCase.query} → ${testCase.expectedSource}`);
    }
  }
  return { hit1, hitK, misses, total: cases.length };
}

export interface MultiHopCase {
  readonly query: string;
  /** EVERY source that must surface for the answer to be assemblable. */
  readonly expectedSources: readonly string[];
}

export interface MultiHopCorpus {
  readonly notes: ReadonlyArray<{ readonly source: string; readonly text: string }>;
  readonly cases: readonly MultiHopCase[];
}

/**
 * Two-hop questions whose answer needs TWO notes jointly ("the team of the
 * person who recommended the book"): single-shot retrieval must surface both
 * or the gate can only refuse/half-answer. Measures whether multi-hop
 * decomposition is a real gap at personal-corpus scale before building it.
 */
export const MULTIHOP_RECALL_CORPUS: MultiHopCorpus = {
  cases: [
    { expectedSources: ["rec-minseo.md", "minseo.md"], query: "사피엔스 추천해준 사람이 무슨 팀이야?" },
    { expectedSources: ["dentist.md", "insurance2.md"], query: "스케일링 받는 치과가 어느 보험으로 처리되지?" },
    { expectedSources: ["trip2.md", "landlord2.md"], query: "여행에서 돌아온 다음 주에 만나야 하는 사람 연락처는?" },
    { expectedSources: ["book-loan.md", "minseo.md"], query: "내 책 빌려간 사람 직책이 뭐야?" },
    { expectedSources: ["standup2.md", "alex.md"], query: "who runs the meeting I attend every weekday morning?" },
    { expectedSources: ["gift.md", "sister.md"], query: "what should I buy for the birthday coming up next month?" }
  ],
  notes: [
    { source: "rec-minseo.md", text: "'사피엔스'는 민서가 강력 추천해준 책이다." },
    { source: "minseo.md", text: "민서는 마케팅팀 팀장이고 직책은 부장이다." },
    { source: "dentist.md", text: "스케일링은 강남미소치과에서 6개월마다 받는다." },
    { source: "insurance2.md", text: "강남미소치과 진료비는 한화 실비보험으로 청구한다." },
    { source: "trip2.md", text: "오사카 여행에서 6월 23일에 돌아온다. 다음 주에 집주인을 만나기로 했다." },
    { source: "landlord2.md", text: "집주인 연락처는 010-9876-5432." },
    { source: "book-loan.md", text: "'팩트풀니스'는 민서가 빌려갔다." },
    { source: "standup2.md", text: "Team standup is every weekday at 9:30 am, hosted by Alex." },
    { source: "alex.md", text: "Alex is the engineering lead based in Berlin." },
    { source: "gift.md", text: "Next month is my sister's birthday." },
    { source: "sister.md", text: "My sister loves ceramic coffee cups and jazz vinyl." }
  ]
};

export interface JointRecallResult {
  readonly total: number;
  /** Cases where EVERY expected source surfaced in the returned top-K. */
  readonly joint: number;
  readonly misses: readonly string[];
}

export async function scoreJointRecall(
  cases: readonly MultiHopCase[],
  rank: (query: string) => Promise<readonly KnowledgeMatch[]>
): Promise<JointRecallResult> {
  let joint = 0;
  const misses: string[] = [];
  for (const testCase of cases) {
    const sources = new Set((await rank(testCase.query)).map((match) => match.source));
    const missing = testCase.expectedSources.filter((source) => !sources.has(source));
    if (missing.length === 0) {
      joint += 1;
    } else {
      misses.push(`${testCase.query} → missing ${missing.join(", ")}`);
    }
  }
  return { joint, misses, total: cases.length };
}
