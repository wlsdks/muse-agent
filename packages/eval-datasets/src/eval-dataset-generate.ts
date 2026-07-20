/**
 * Deterministic record generation for the synthetic eval corpus: the
 * per-tier seeds, localized templates, and the sequence -> record mapping.
 * Imports the contract leaf; the I/O layer in `index.ts` imports THIS, so
 * this module must never import back from `index.js`.
 */

import { createHash } from "node:crypto";

import {
  COMPLEXITIES,
  EVIDENCE_CLASS,
  FAMILIES,
  GENERATOR_VERSION,
  LOCALES,
  SCHEMA_VERSION,
  TIERS,
  type CellCounts,
  type Complexity,
  type EvalRecord,
  type Family,
  type Locale,
  type Tier
} from "./eval-dataset-contract.js";

const SCALE_SEEDS: Record<Tier, number> = {
  1_000: 120_031,
  10_000: 220_033,
  100_000: 320_039,
  1_000_000: 420_041,
};
export { SCALE_SEEDS };

const LEXICONS: Record<Locale, readonly string[]> = {
  en: ["Aster Kiln", "Morrow Orchard", "Juniper Relay", "Cobalt Harbor"],
  ko: ["별꽃 가마", "모로 과수원", "향나무 중계", "코발트 항구"],
  ja: ["アスター窯", "モロウ果樹園", "ジュニパー中継", "コバルト港"],
  "zh-CN": ["星菊窑", "莫罗果园", "杜松中继", "钴蓝港"],
};

const MEMORY_OPERATIONS = ["add", "update", "delete", "noop"] as const;
const AUTHORITY_STATUSES = ["missing", "expired", "revoked", "valid"] as const;
const CELL_COUNT = FAMILIES.length * LOCALES.length * COMPLEXITIES.length;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function cellKey(family: Family, locale: Locale, complexity: Complexity): string {
  return `${family}|${locale}|${complexity}`;
}

export function decodeCell(sequence: number, seed: number): {
  family: Family;
  locale: Locale;
  complexity: Complexity;
  cycle: number;
} {
  const cell = (sequence + Math.abs(seed % CELL_COUNT)) % CELL_COUNT;
  const family = FAMILIES[Math.floor(cell / (LOCALES.length * COMPLEXITIES.length))]!;
  const withinFamily = cell % (LOCALES.length * COMPLEXITIES.length);
  const locale = LOCALES[Math.floor(withinFamily / COMPLEXITIES.length)]!;
  const complexity = COMPLEXITIES[withinFamily % COMPLEXITIES.length]!;
  return { family, locale, complexity, cycle: Math.floor(sequence / CELL_COUNT) };
}

type LocalizedTemplates = {
  marker: (lexeme: string, scenarioId: string, complexity: Complexity) => string;
  recallQuery: (marker: string) => string;
  current: (marker: string) => string;
  stale: (marker: string) => string;
  distractor: (scenarioId: string) => string;
  absentQuery: (marker: string) => string;
  absentCorpus: (scenarioId: string) => string;
  thread: (marker: string) => string;
  artifact: (scenarioId: string) => string;
  existing: (marker: string) => string;
  incoming: (marker: string) => string;
  retraction: string;
  context: (turn: number, marker: string) => string;
};

function complexityLabel(locale: Locale, complexity: Complexity): string {
  const labels: Record<Locale, Record<Complexity, string>> = {
    en: { simple: "one step", medium: "two linked steps", complex: "three constraints", "long-context": "a long-running work thread" },
    ko: { simple: "한 단계", medium: "이어진 두 단계", complex: "세 가지 제약", "long-context": "오래 이어진 업무 흐름" },
    ja: { simple: "一段階", medium: "連続する二段階", complex: "三つの制約", "long-context": "長く続く仕事の流れ" },
    "zh-CN": { simple: "单一步骤", medium: "两个连续步骤", complex: "三项约束", "long-context": "持续较久的工作脉络" },
  };
  return labels[locale][complexity];
}

const TEMPLATES: Record<Locale, LocalizedTemplates> = {
  en: {
    marker: (lexeme, scenarioId, complexity) => `${lexeme} ${scenarioId}, ${complexityLabel("en", complexity)}`,
    recallQuery: (marker) => `Which revision is current for the work plan at ${marker}?`,
    current: (marker) => `The accepted current work revision for ${marker} keeps the cobalt milestone.`,
    stale: (marker) => `This superseded work revision for ${marker} used the earlier violet milestone.`,
    distractor: (scenarioId) => `A fictional home-garden rehearsal for ${scenarioId} mentions quartz.` ,
    absentQuery: (marker) => `What is the confirmed household delivery window for ${marker}?`,
    absentCorpus: (scenarioId) => `The fictional work almanac for ${scenarioId} only describes a violet rehearsal.`,
    thread: (marker) => `Continue the shared work plan for ${marker}`,
    artifact: (scenarioId) => `Review the next fictional task for ${scenarioId}`,
    existing: (marker) => `Prefer a quiet morning review for ${marker}.`,
    incoming: (marker) => `Prefer a focused afternoon review for ${marker}.`,
    retraction: "forget this preference",
    context: (turn, marker) => `Synthetic work turn ${turn}: keep the next step for ${marker} explicit.`,
  },
  ko: {
    marker: (lexeme, scenarioId, complexity) => `${lexeme} ${scenarioId}의 ${complexityLabel("ko", complexity)}`,
    recallQuery: (marker) => `${marker} 업무 계획에서 현재 확정된 개정안은 무엇인가요?`,
    current: (marker) => `${marker} 업무의 최신 확정안은 코발트 이정표를 유지합니다.`,
    stale: (marker) => `${marker} 업무의 이전 폐기안은 바이올렛 이정표를 사용했습니다.`,
    distractor: (scenarioId) => `${scenarioId}의 가상 생활 정원 연습에는 석영 이야기가 나옵니다.`,
    absentQuery: (marker) => `${marker} 생활 물품의 확정 배송 시간은 언제인가요?`,
    absentCorpus: (scenarioId) => `${scenarioId}의 가상 업무 기록에는 바이올렛 연습만 적혀 있습니다.`,
    thread: (marker) => `${marker} 공동 업무 계획 이어가기`,
    artifact: (scenarioId) => `${scenarioId}의 다음 가상 할 일 검토`,
    existing: (marker) => `${marker} 검토는 조용한 아침을 선호합니다.`,
    incoming: (marker) => `${marker} 검토는 집중할 수 있는 오후를 선호합니다.`,
    retraction: "이 선호를 잊어줘",
    context: (turn, marker) => `합성 업무 대화 ${turn}: ${marker}의 다음 단계를 명확히 유지합니다.`,
  },
  ja: {
    marker: (lexeme, scenarioId, complexity) => `${lexeme} ${scenarioId}の${complexityLabel("ja", complexity)}`,
    recallQuery: (marker) => `${marker}の仕事計画で現在確定している改訂版はどれですか。`,
    current: (marker) => `${marker}の最新確定版はコバルトの節目を維持します。`,
    stale: (marker) => `${marker}の廃止済み旧版はバイオレットの節目を使っていました。`,
    distractor: (scenarioId) => `${scenarioId}の架空の暮らしの庭仕事には石英の話が出ます。`,
    absentQuery: (marker) => `${marker}の生活用品について確定した配達時間はいつですか。`,
    absentCorpus: (scenarioId) => `${scenarioId}の架空の仕事記録にはバイオレットの練習だけがあります。`,
    thread: (marker) => `${marker}の共同作業計画を続ける`,
    artifact: (scenarioId) => `${scenarioId}の次の架空タスクを確認する`,
    existing: (marker) => `${marker}の確認は静かな朝を好みます。`,
    incoming: (marker) => `${marker}の確認は集中できる午後を好みます。`,
    retraction: "この好みを忘れて",
    context: (turn, marker) => `合成された仕事の会話 ${turn}: ${marker}の次の手順を明確に保ちます。`,
  },
  "zh-CN": {
    marker: (lexeme, scenarioId, complexity) => `${lexeme} ${scenarioId}的${complexityLabel("zh-CN", complexity)}`,
    recallQuery: (marker) => `${marker}工作计划中当前确认的修订版是哪一个？`,
    current: (marker) => `${marker}工作的最新确认版本保留钴蓝里程碑。`,
    stale: (marker) => `${marker}工作中已废弃的旧版本使用紫罗兰里程碑。`,
    distractor: (scenarioId) => `${scenarioId}的虚构生活园艺记录提到了石英。`,
    absentQuery: (marker) => `${marker}生活用品已确认的配送时间是什么？`,
    absentCorpus: (scenarioId) => `${scenarioId}的虚构工作记录只描述了紫罗兰排练。`,
    thread: (marker) => `继续推进${marker}的协作工作计划`,
    artifact: (scenarioId) => `检查${scenarioId}的下一个虚构任务`,
    existing: (marker) => `${marker}的复盘偏好安静的上午。`,
    incoming: (marker) => `${marker}的复盘偏好专注的下午。`,
    retraction: "忘记这项偏好",
    context: (turn, marker) => `合成工作对话 ${turn}：明确保留${marker}的下一步。`,
  },
};

type RecordWithoutHash = Omit<EvalRecord, "contentHash">;

export function generateRecord(tier: Tier, seed: number, sequence: number, options: { robustnessReplay?: boolean } = {}): EvalRecord {
  if (!TIERS.includes(tier) || !Number.isSafeInteger(seed) || !Number.isInteger(sequence) || sequence < 0 || sequence >= tier) {
    throw new Error("Invalid tier, seed, or sequence");
  }
  const { family, locale, complexity, cycle } = decodeCell(sequence, seed);
  const lexemeIndex = Math.abs((cycle + seed) % LEXICONS[locale].length);
  const lexeme = LEXICONS[locale][lexemeIndex]!;
  const lexemeId = `${locale}-${lexemeIndex}`;
  const templateId = `${family}-${locale}-${complexity}`;
  const scenarioId = `scenario-${Math.abs(seed)}-${cycle}`;
  const templates = TEMPLATES[locale];
  const marker = templates.marker(lexeme, scenarioId, complexity);
  const common = {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    recordId: "",
    sequence,
    tier,
    seed,
    family,
    locale,
    complexity,
    dataOrigin: "synthetic" as const,
    organicEvidence: false as const,
    personalLearningEligible: false as const,
    humanOutcome: false as const,
    heldOut: false as const,
    evidenceClass: EVIDENCE_CLASS,
    robustnessReplay: options.robustnessReplay === true,
    topicHash: "",
  };
  let withoutHash: RecordWithoutHash;
  switch (family) {
    case "recall-correction":
      withoutHash = {
        ...common,
        family,
        payload: {
          templateId,
          lexemeId,
          scenarioId,
          query: templates.recallQuery(marker),
          current: templates.current(marker),
          stale: templates.stale(marker),
          distractor: templates.distractor(scenarioId),
        },
        expected: { terminal: "current-before-stale" },
      };
      break;
    case "absent-abstention":
      {
      const unrelatedArchiveId = `archive-${sha256(`absent\0${seed}\0${cycle}\0${locale}`).slice(0, 12)}`;
      withoutHash = {
        ...common,
        family,
        payload: {
          templateId,
          lexemeId,
          scenarioId,
          query: templates.absentQuery(marker),
          corpus: templates.absentCorpus(unrelatedArchiveId),
        },
        expected: { terminal: "abstain" },
      };
      break;
      }
    case "continuity":
      withoutHash = {
        ...common,
        family,
        payload: {
          templateId,
          lexemeId,
          scenarioId,
          threadTitle: templates.thread(marker),
          artifactTitle: templates.artifact(scenarioId),
        },
        expected: { terminal: "controlled-excluded-from-next" },
      };
      break;
    case "memory-preference-veto-correction": {
      const operation = MEMORY_OPERATIONS[(cycle + lexemeIndex) % MEMORY_OPERATIONS.length]!;
      const existing = templates.existing(marker);
      const incoming = operation === "noop" ? existing : operation === "delete" ? templates.retraction : templates.incoming(marker);
      withoutHash = {
        ...common,
        family,
        payload: {
          templateId,
          lexemeId,
          scenarioId,
          operation,
          key: `fictional-preference-${lexemeId}-${cycle}`,
          existing,
          incoming,
        },
        expected: { terminal: "memory-operation", operation },
      };
      break;
    }
    case "tool-policy-approval":
      withoutHash = {
        ...common,
        family,
        payload: {
          templateId,
          lexemeId,
          scenarioId,
          action: `fictional.task.transition.${cycle}`,
          authorityStatus: AUTHORITY_STATUSES[(cycle + lexemeIndex) % AUTHORITY_STATUSES.length]!,
          hardDeny: true,
        },
        expected: { terminal: "deny" },
      };
      break;
    case "context-stress": {
      const messageCount = complexity === "long-context" ? 32 : complexity === "complex" ? 8 : complexity === "medium" ? 4 : 2;
      withoutHash = {
        ...common,
        family,
        payload: {
          templateId,
          lexemeId,
          scenarioId,
          messages: Array.from({ length: messageCount }, (_, index) => templates.context(index, marker)),
          maxContextWindowTokens: 512,
          outputReserveTokens: 128,
        },
        expected: { terminal: "within-budget", trimmingRequired: complexity === "long-context" },
      };
      break;
    }
  }
  const semantic = {
    family,
    locale,
    complexity,
    payload: withoutHash.payload,
    expected: withoutHash.expected,
  };
  const topicHash = sha256(JSON.stringify({ family, locale, complexity, templateId, lexemeId, scenarioId }));
  const contentHash = sha256(JSON.stringify(semantic));
  const recordId = `eval-${GENERATOR_VERSION}-${tier}-${seed}-${sequence}-${contentHash.slice(0, 12)}`;
  return { ...withoutHash, recordId, topicHash, contentHash } as EvalRecord;
}

export function assertExactSyntheticRecord(value: unknown): asserts value is EvalRecord {
  if (!value || typeof value !== "object") throw new Error("Record must be an object");
  const candidate = value as Partial<EvalRecord>;
  if (candidate.dataOrigin !== "synthetic" || candidate.organicEvidence !== false || candidate.personalLearningEligible !== false || candidate.humanOutcome !== false || candidate.heldOut !== false || candidate.evidenceClass !== EVIDENCE_CLASS || typeof candidate.robustnessReplay !== "boolean") {
    throw new Error("Synthetic provenance and non-learning fields must be explicit and fail closed");
  }
  if (!TIERS.includes(candidate.tier as Tier) || !Number.isSafeInteger(candidate.seed) || !Number.isInteger(candidate.sequence)) {
    throw new Error("Record identity fields are invalid");
  }
  const expected = generateRecord(candidate.tier as Tier, candidate.seed as number, candidate.sequence as number, { robustnessReplay: candidate.robustnessReplay });
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error("Record is not an exact member of the fixed fictional generator allowlist");
  }
  const encoded = Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
  if (encoded > 16_384) throw new Error(`Record exceeds 16 KiB: ${encoded}`);
}

export function expectedCellCounts(tier: Tier, seed: number): CellCounts {
  const counts: CellCounts = {};
  for (const family of FAMILIES) for (const locale of LOCALES) for (const complexity of COMPLEXITIES) counts[cellKey(family, locale, complexity)] = 0;
  for (let sequence = 0; sequence < tier; sequence += 1) {
    const decoded = decodeCell(sequence, seed);
    const key = cellKey(decoded.family, decoded.locale, decoded.complexity);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
