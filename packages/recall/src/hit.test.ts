import { describe, expect, it } from "vitest";

import { buildAskConnections } from "./hit.js";

describe("buildAskConnections — stale demotion wired into the related-footer", () => {
  it("a higher-scored STALE note is demoted below a current one (OUTCOME)", () => {
    const out = buildAskConnections({
      notes: [
        { file: "home_old.md", score: 0.95, text: "예전에는 서울에 살았었다. 지금은 아니다." },
        { file: "home.md", score: 0.6, text: "지금 사는 도시는 부산이다." }
      ],
      episodes: [],
      minScore: 0.5
    });
    expect(out.map((h) => h.ref)).toEqual(["home.md", "home_old.md"]);
  });

  it("ordinary (no stale marker) ordering is unchanged — pure score order", () => {
    const out = buildAskConnections({
      notes: [
        { file: "a.md", score: 0.9, text: "지금 사는 도시는 부산이다." },
        { file: "b.md", score: 0.7, text: "내 차는 회색 아반떼다." }
      ],
      episodes: [],
      minScore: 0.5
    });
    expect(out.map((h) => h.ref)).toEqual(["a.md", "b.md"]);
  });

  it("the floor + limit still apply after demotion", () => {
    const out = buildAskConnections({
      notes: [
        { file: "lo.md", score: 0.4, text: "below floor" },
        { file: "ok.md", score: 0.8, text: "지금 유효한 사실" }
      ],
      episodes: [],
      minScore: 0.5,
      limit: 4
    });
    expect(out.map((h) => h.ref)).toEqual(["ok.md"]); // below-floor dropped, current kept
  });
});
