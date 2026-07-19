/**
 * NON-HELD-OUT DEVELOPMENT MATRIX.
 *
 * These fixtures are authored for matcher development and MUST be excluded
 * from any later held-out recall dataset. They are not product-quality evidence.
 * Run: pnpm exec tsx scripts/dev-recall-conflict-pair-matrix.ts
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { embed } from "../packages/recall/src/embed.js";
import { retrieveAndRankNotes } from "../packages/recall/src/ask-note-retrieval.js";
import type { FileEntry } from "../packages/recall/src/chunks.js";

const MODELS = [
  "nomic-embed-text",
  "nomic-embed-text-v2-moe",
  "embeddinggemma",
  "qwen3-embedding:0.6b"
] as const;

type Locale = "KO" | "EN";
type MatrixCase = {
  readonly id: string;
  readonly locale: Locale;
  readonly query: string;
  readonly current: string;
  readonly stale: string;
  readonly distractor: string;
};

export const DEVELOPMENT_MATRIX = Object.freeze({
  dataOrigin: "synthetic non-held-out development matrix",
  heldOut: false,
  organicEvidence: false,
  positives: [
    { id: "en-ceramic-kiln", locale: "EN", query: "What is the ceramic kiln vent setting?", current: "Ceramic kiln vent setting is 42 now.", stale: "I used to keep the ceramic kiln vent setting at 31; no longer current.", distractor: "Alpine weather station battery report." },
    { id: "en-rooftop-beehive", locale: "EN", query: "What is the rooftop beehive feeder interval?", current: "Rooftop beehive feeder interval is nine days now.", stale: "I used to set the rooftop beehive feeder interval to five days; no longer current.", distractor: "Museum ticket envelope inventory." },
    { id: "en-cello-humidifier", locale: "EN", query: "What is the cello bridge humidifier refill level?", current: "Cello bridge humidifier refill level is 55 percent now.", stale: "I used to use a cello bridge humidifier refill level of 30 percent; no longer current.", distractor: "Coastal lighthouse lens cleaning log." },
    { id: "en-rye-starter", locale: "EN", query: "What is the rye sourdough starter feeding ratio?", current: "Rye sourdough starter feeding ratio is one to four now.", stale: "I used to keep the rye sourdough starter feeding ratio at one to two; no longer current.", distractor: "Woodland trail camera memory card." },
    { id: "en-telescope-collimation", locale: "EN", query: "What is the backyard telescope collimation screw offset?", current: "Backyard telescope collimation screw offset is two turns now.", stale: "I used to keep the backyard telescope collimation screw offset at four turns; no longer current.", distractor: "Bamboo cutting board oiling note." },
    { id: "en-speckled-orchid", locale: "EN", query: "What is the speckled orchid misting schedule?", current: "Speckled orchid misting schedule is every Thursday now.", stale: "I used to follow a speckled orchid misting schedule every Monday; no longer current.", distractor: "Attic telescope case zipper repair." },
    { id: "en-bicycle-dynamo", locale: "EN", query: "What is the touring bicycle dynamo voltage limit?", current: "Touring bicycle dynamo voltage limit is six volts now.", stale: "I used to set the touring bicycle dynamo voltage limit to eight volts; no longer current.", distractor: "Garden pond filter sponge size." },
    { id: "en-saffron-jar", locale: "EN", query: "Which saffron pantry storage jar is current?", current: "Saffron pantry storage jar is the blue tin now.", stale: "I used to keep the saffron pantry storage jar in the amber tin; no longer current.", distractor: "Workshop solder spool diameter." },
    { id: "ko-sesame-shelf", locale: "KO", query: "참기름 유리병 보관 위치는 어디인가?", current: "참기름 유리병 보관 위치: 아래 선반.", stale: "예전에 참기름 유리병 보관 위치: 위 선반. 지금은 아니다.", distractor: "옥상 풍향계 나사 점검 기록." },
    { id: "ko-coral-light", locale: "KO", query: "산호 수조 조명 시간은 몇 시간인가?", current: "산호 수조 조명 시간: 7시간.", stale: "예전에 산호 수조 조명 시간: 10시간. 지금은 아니다.", distractor: "목공 끌 손잡이 오일 기록." },
    { id: "ko-hiking-pole", locale: "KO", query: "등산 스틱 길이 설정은 얼마인가?", current: "등산 스틱 길이 설정: 112센티미터.", stale: "예전에 등산 스틱 길이 설정: 105센티미터. 지금은 아니다.", distractor: "베란다 화분 받침 주문 기록." },
    { id: "ko-hanbok-repellent", locale: "KO", query: "한복 보관 방충제 종류는 무엇인가?", current: "한복 보관 방충제 종류: 삼나무.", stale: "예전에 한복 보관 방충제 종류: 나프탈렌. 지금은 아니다.", distractor: "휴대용 라디오 안테나 수리 기록." },
    { id: "ko-drone-propeller", locale: "KO", query: "드론 프로펠러 교체 주기는 얼마인가?", current: "드론 프로펠러 교체 주기: 40회.", stale: "예전에 드론 프로펠러 교체 주기: 25회. 지금은 아니다.", distractor: "도서관 희귀본 장갑 규격." },
    { id: "ko-kimchi-temperature", locale: "KO", query: "김치 냉장고 숙성 온도는 몇 도인가?", current: "김치 냉장고 숙성 온도: 2도.", stale: "예전에 김치 냉장고 숙성 온도: 5도. 지금은 아니다.", distractor: "현관 우산꽂이 배수 기록." },
    { id: "ko-sewing-needle", locale: "KO", query: "재봉틀 가죽 바늘 규격은 몇 호인가?", current: "재봉틀 가죽 바늘 규격: 16호.", stale: "예전에 재봉틀 가죽 바늘 규격: 14호. 지금은 아니다.", distractor: "천체 관측 의자 높이 기록." },
    { id: "ko-monstera-soil", locale: "KO", query: "몬스테라 분갈이 흙 비율은 무엇인가?", current: "몬스테라 분갈이 흙 비율: 코코피트 3.", stale: "예전에 몬스테라 분갈이 흙 비율: 코코피트 1. 지금은 아니다.", distractor: "수제 비누 건조 선반 기록." }
  ] satisfies readonly MatrixCase[],
  hardNegatives: [
    { id: "en-python-flask", locale: "EN", query: "Where is the Python flask inventory?", current: "Python flask inventory is on shelf four.", stale: "I used to maintain the Python Flask web service; no longer current.", distractor: "Copper sundial shadow chart." },
    { id: "en-java-spring", locale: "EN", query: "Which Java spring water bag is packed?", current: "Java spring water bag is packed in the green crate.", stale: "I used to maintain the Java Spring payment service; no longer current.", distractor: "Porcelain teapot handle sketch." },
    { id: "en-mercury-transit", locale: "EN", query: "Where is the Mercury transit chart?", current: "Mercury transit chart is inside the astronomy binder.", stale: "I used to support the Mercury Transit commuter application; no longer current.", distractor: "Pine seedling humidity note." },
    { id: "en-pitch-deck", locale: "EN", query: "What is the pitch deck drainage slope?", current: "Pitch deck drainage slope is twelve degrees.", stale: "I used to edit the startup pitch deck revenue slide; no longer current.", distractor: "Violin rosin storage pouch." },
    { id: "en-bass-bridge", locale: "EN", query: "What is the bass bridge gauge?", current: "Bass bridge gauge is seven millimeters.", stale: "I used to photograph bass beneath the bridge; no longer current.", distractor: "Greenhouse shade cloth invoice." },
    { id: "en-ruby-rails", locale: "EN", query: "Where is the ruby rails bracket?", current: "Ruby rails bracket is in drawer nine.", stale: "I used to maintain the Ruby Rails reporting service; no longer current.", distractor: "Canoe paddle varnish schedule." },
    { id: "en-crane-harbor", locale: "EN", query: "Where is the crane harbor sensor?", current: "Crane harbor sensor is beside the bird blind.", stale: "I used to inspect the crane harbor construction boom; no longer current.", distractor: "Linen curtain hem measurement." },
    { id: "en-draft-board", locale: "EN", query: "Where is the draft board pencil guide?", current: "Draft board pencil guide is under the vellum pad.", stale: "I used to manage the team draft board rankings; no longer current.", distractor: "Orchard ladder rung count." },
    { id: "ko-python-flask", locale: "KO", query: "파이썬 플라스크 재고는 어디에 있는가?", current: "파이썬 플라스크 재고: 실험실 4번 선반.", stale: "예전에 파이썬 플라스크 웹서비스를 관리했다. 지금은 아니다.", distractor: "대나무 발 건조 시간 기록." },
    { id: "ko-java-spring", locale: "KO", query: "자바 스프링 원두는 어디에 있는가?", current: "자바 스프링 원두: 초록 상자.", stale: "예전에 자바 스프링 결제 서버를 관리했다. 지금은 아니다.", distractor: "도자기 물레 페달 점검 기록." },
    { id: "ko-safari-booking", locale: "KO", query: "사파리 예약 장부는 어디에 있는가?", current: "사파리 예약 장부: 여행 서랍.", stale: "예전에 사파리 예약 브라우저 확장을 개발했다. 지금은 아니다.", distractor: "정원 분수 펌프 영수증." },
    { id: "ko-mercury-transit", locale: "KO", query: "수성 통과 관측표는 어디에 있는가?", current: "수성 통과 관측표: 천문 파일.", stale: "예전에 수성 통과 교통 앱을 운영했다. 지금은 아니다.", distractor: "양모 담요 세탁 온도 기록." },
    { id: "ko-bass-bridge", locale: "KO", query: "베이스 브리지 높이는 얼마인가?", current: "베이스 브리지 높이: 8밀리미터.", stale: "예전에 베이스 브리지 아래 물고기를 촬영했다. 지금은 아니다.", distractor: "옥수수 제분기 손잡이 규격." },
    { id: "ko-ruby-rails", locale: "KO", query: "루비 레일 받침은 어디에 있는가?", current: "루비 레일 받침: 공구함 6번 칸.", stale: "예전에 루비 레일 보고서 서버를 관리했다. 지금은 아니다.", distractor: "유리 온실 창문 잠금 기록." },
    { id: "ko-crane-harbor", locale: "KO", query: "크레인 항구 센서는 어디에 있는가?", current: "크레인 항구 센서: 조류 관찰대 옆.", stale: "예전에 크레인 항구 건설 장비를 점검했다. 지금은 아니다.", distractor: "자전거 안장 가죽 관리 기록." },
    { id: "ko-draft-board", locale: "KO", query: "드래프트 보드 연필자는 어디에 있는가?", current: "드래프트 보드 연필자: 제도함 아래칸.", stale: "예전에 드래프트 보드 선수 순위를 관리했다. 지금은 아니다.", distractor: "밤나무 묘목 물주기 기록." }
  ] satisfies readonly MatrixCase[]
});

function normalizedMatrixDigest(): string {
  const values = [...DEVELOPMENT_MATRIX.positives, ...DEVELOPMENT_MATRIX.hardNegatives]
    .flatMap((item) => [item.id, item.query, item.current, item.stale, item.distractor])
    .map((value) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim())
    .sort();
  return createHash("sha256").update(values.join("\n"), "utf8").digest("hex");
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "muse-conflict-dev-matrix-"));
  const priorGraph = process.env.MUSE_RECALL_GRAPH_HOP;
  const priorSecond = process.env.MUSE_RECALL_SECOND_HOP;
  process.env.MUSE_RECALL_GRAPH_HOP = "false";
  process.env.MUSE_RECALL_SECOND_HOP = "false";
  try {
    const failures: string[] = [];
    const metrics: Record<string, Record<Locale, { positives: number; positiveTotal: number; falsePairs: number; negativeTotal: number }>> = {};
    const models = process.env.MUSE_DEV_MATRIX_MODEL
      ? MODELS.filter((model) => model === process.env.MUSE_DEV_MATRIX_MODEL)
      : MODELS;
    if (models.length === 0) throw new Error(`unknown MUSE_DEV_MATRIX_MODEL: ${process.env.MUSE_DEV_MATRIX_MODEL ?? ""}`);
    for (const model of models) {
      const cache = new Map<string, number[]>();
      const vector = async (text: string): Promise<number[]> => {
        const cached = cache.get(text);
        if (cached) return cached;
        const value = await embed(text, model, { requireLocalOnly: true, timeoutMs: 60_000 });
        cache.set(text, value);
        return value;
      };
      metrics[model] = {
        EN: { falsePairs: 0, negativeTotal: 0, positives: 0, positiveTotal: 0 },
        KO: { falsePairs: 0, negativeTotal: 0, positives: 0, positiveTotal: 0 }
      };
      for (const [kind, cases] of [["positive", DEVELOPMENT_MATRIX.positives], ["negative", DEVELOPMENT_MATRIX.hardNegatives]] as const) {
        for (const item of cases) {
          const caseDir = join(root, model.replaceAll(/[/:]/gu, "-"), item.id);
          const entries: Record<"current" | "stale" | "distractor", FileEntry> = {} as never;
          await mkdir(caseDir, { recursive: true });
          for (const role of ["current", "stale", "distractor"] as const) {
            const path = join(caseDir, `${role}.md`);
            await writeFile(path, item[role], "utf8");
            entries[role] = { chunks: [{ chunkIndex: 0, embedding: await vector(item[role]), file: path, text: item[role] }], path };
          }
          const passedByDirection: boolean[] = [];
          for (const anchor of ["current", "stale"] as const) {
            const result = await retrieveAndRankNotes({
              embedFn: async (text) => vector(text), embedModel: model,
              indexFiles: [entries.current, entries.stale, entries.distractor], json: true, notesDir: caseDir,
              onStderr: () => {}, query: item.query,
              rerankFn: async (_query, texts) => [texts.indexOf(item[anchor]), texts.indexOf(item.distractor)],
              scope: undefined, topK: 2
            });
            const files = new Set(result.scored.map((entry) => entry.file));
            passedByDirection.push(kind === "positive"
              ? files.has(entries.current.path) && files.has(entries.stale.path) && result.scored.length === 2
              : !(files.has(entries.current.path) && files.has(entries.stale.path)) && result.scored.length === 2);
          }
          const metric = metrics[model]![item.locale];
          if (kind === "positive") {
            metric.positiveTotal += 1;
            if (passedByDirection.every(Boolean)) metric.positives += 1;
          } else {
            metric.negativeTotal += 1;
            if (!passedByDirection.every(Boolean)) {
              metric.falsePairs += 1;
              failures.push(`${model}:${item.locale}:${item.id}`);
            }
          }
        }
      }
    }
    const summary = {
      dataOrigin: DEVELOPMENT_MATRIX.dataOrigin,
      heldOut: false,
      failures,
      matrixDigest: normalizedMatrixDigest(),
      metrics,
      organicEvidence: false
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    const failed = Object.values(metrics).some((locales) => Object.values(locales)
      .some((metric) => metric.positives !== metric.positiveTotal || metric.falsePairs !== 0));
    if (failed) process.exitCode = 1;
  } finally {
    if (priorGraph === undefined) delete process.env.MUSE_RECALL_GRAPH_HOP;
    else process.env.MUSE_RECALL_GRAPH_HOP = priorGraph;
    if (priorSecond === undefined) delete process.env.MUSE_RECALL_SECOND_HOP;
    else process.env.MUSE_RECALL_SECOND_HOP = priorSecond;
    await rm(root, { force: true, recursive: true });
  }
}

await main();
