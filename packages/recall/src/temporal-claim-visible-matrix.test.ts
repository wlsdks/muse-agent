import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  activateTemporalClaimGraphV1,
  createNoteSpanIdentityV1,
  createSupersedesRelationV1,
  createTemporalClaimGraphV1,
  type NoteSourceIndexViewV1
} from "./index.js";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

const domains = ["life", "health", "work", "preference", "reference"] as const;
const locales = ["ko", "en"] as const;
const states = [
  "current-endpoint", "stale-endpoint", "declined", "unconfirmed",
  "tampered-source", "stale-index", "unrelated", "historical"
] as const;

const facts = {
  en: {
    life: ["My parcel pickup is at Mapo station", "My parcel pickup used to be at City Hall station"],
    health: ["My vitamin dose is two tablets", "My vitamin dose used to be one tablet"],
    work: ["The Muse release branch is main", "The Muse release branch used to be develop"],
    preference: ["I prefer jasmine tea after lunch", "I used to prefer coffee after lunch"],
    reference: ["The WireGuard listen port is 51821", "The WireGuard listen port used to be 51820"]
  },
  ko: {
    life: ["택배 수령 장소는 마포역이다", "택배 수령 장소는 예전에 시청역이었다"],
    health: ["비타민 복용량은 두 알이다", "비타민 복용량은 예전에 한 알이었다"],
    work: ["Muse 배포 브랜치는 main이다", "Muse 배포 브랜치는 예전에 develop이었다"],
    preference: ["점심 뒤에는 자스민 차를 선호한다", "점심 뒤에는 예전에 커피를 선호했다"],
    reference: ["WireGuard 수신 포트는 51821이다", "WireGuard 수신 포트는 예전에 51820이었다"]
  }
} as const;

function queryFor(locale: typeof locales[number], domain: typeof domains[number], state: typeof states[number]): string {
  if (state === "unrelated") return locale === "ko" ? "여권 갱신 날짜" : "passport renewal date";
  if (state === "historical") return locale === "ko" ? `${facts[locale][domain][1]} 예전에 무엇이었나` : `what was formerly true: ${facts[locale][domain][1]}`;
  return facts[locale][domain][0];
}

function endpoint(sourcePath: string, text: string) {
  const sourceBytes = Buffer.from(text);
  const sourceIndex: NoteSourceIndexViewV1 = {
    chunkerVersion: "muse.notes.chunk-text.v1", chunks: [{ chunkIndex: 0, text }],
    notesIndexSchema: 2, sourceHash: sha256(sourceBytes), sourcePath
  };
  return {
    identity: createNoteSpanIdentityV1({ sourceBytes, sourceIndex, chunkIndex: 0, start: 0, end: Buffer.byteLength(text) }),
    sourceBytes, sourceIndex, text
  };
}

function buildCase(locale: typeof locales[number], domain: typeof domains[number], state: typeof states[number]) {
  const root = "/visible-matrix";
  const current = endpoint(`${locale}-${domain}-current.md`, facts[locale][domain][0]);
  const stale = endpoint(`${locale}-${domain}-stale.md`, facts[locale][domain][1]);
  const relation = createSupersedesRelationV1({
    authoredAt: "2026-07-21T00:00:00.000Z",
    current: { context: { sourceBytes: current.sourceBytes, sourceIndex: current.sourceIndex }, identity: current.identity },
    edgeId: sha256(`${locale}:${domain}`).slice(0, 32),
    stale: { context: { sourceBytes: stale.sourceBytes, sourceIndex: stale.sourceIndex }, identity: stale.identity }
  });
  const graph = createTemporalClaimGraphV1({ relations: state === "declined" || state === "unconfirmed" ? [] : [relation] });
  const currentPath = `${root}/${current.identity.sourcePath}`;
  const stalePath = `${root}/${stale.identity.sourcePath}`;
  const topIsStale = state === "stale-endpoint";
  const candidates = [
    { chunk: { chunkIndex: 0, embedding: [1, 0], file: currentPath, text: current.text }, file: currentPath, score: topIsStale ? 0.8 : 1 },
    { chunk: { chunkIndex: 0, embedding: [0.8, 0.2], file: stalePath, text: stale.text }, file: stalePath, score: topIsStale ? 1 : 0.8 }
  ];
  const indexFiles = [
    { chunks: [candidates[0]!.chunk], chunkerVersion: current.sourceIndex.chunkerVersion, path: currentPath, sourceHash: state === "tampered-source" ? "0".repeat(64) : current.sourceIndex.sourceHash },
    { chunks: [{ ...candidates[1]!.chunk, text: state === "stale-index" ? `${stale.text} changed` : stale.text }], chunkerVersion: stale.sourceIndex.chunkerVersion, path: stalePath, sourceHash: stale.sourceIndex.sourceHash }
  ];
  return { candidates, currentPath, graph, indexFiles, query: queryFor(locale, domain, state), root, stalePath };
}

describe("temporal-links-visible-v1 exact 80-cell matrix", () => {
  const cases = locales.flatMap((locale) => domains.flatMap((domain) => states.map((state) => ({ domain, locale, state }))));

  it("keeps the frozen matrix dimensions and every cell as a hard gate", () => {
    expect(cases).toHaveLength(80);
    expect(cases.filter(({ state }) => state.endsWith("endpoint"))).toHaveLength(20);
    for (const entry of cases) {
      const fixture = buildCase(entry.locale, entry.domain, entry.state);
      const activated = activateTemporalClaimGraphV1({
        candidates: fixture.candidates, confidentAt: 0.7, graph: fixture.graph,
        indexFiles: fixture.indexFiles, notesDir: fixture.root, query: fixture.query, topK: 2
      });
      const positive = entry.state === "current-endpoint" || entry.state === "stale-endpoint";
      expect(activated !== undefined, `${entry.locale}/${entry.domain}/${entry.state}`).toBe(positive);
      if (positive) {
        expect(activated?.scored.map(({ file }) => file), `${entry.locale}/${entry.domain}/${entry.state}`)
          .toEqual([fixture.currentPath, fixture.stalePath]);
        expect(activated?.verifiedCorrectionPair.current.file).toBe(fixture.currentPath);
        expect(activated?.verifiedCorrectionPair.stale.file).toBe(fixture.stalePath);
      }
    }
  });
});
