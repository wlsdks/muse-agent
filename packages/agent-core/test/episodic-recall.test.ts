import { describe, expect, it } from "vitest";

import {
  cosineSimilarity,
  InMemoryEpisodicRecallProvider,
  renderEpisodicSection
} from "../src/episodic-recall.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBe(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 for empty / mismatched-length input", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [3])).toBe(0);
  });
});

describe("InMemoryEpisodicRecallProvider", () => {
  const provider = new InMemoryEpisodicRecallProvider({
    episodes: [
      {
        createdAtIso: "2026-05-10T00:00:00.000Z",
        narrative: "Discussed the JARVIS roadmap and active-context design for Muse",
        sessionId: "s-1"
      },
      {
        createdAtIso: "2026-05-09T00:00:00.000Z",
        narrative: "Reviewed Slack integration design and inbox-store schema",
        sessionId: "s-2"
      }
    ],
    minScore: 0.05,
    topK: 2
  });

  it("returns top-K matches by token overlap", async () => {
    const snapshot = await provider.resolve("Tell me about JARVIS active context");
    expect(snapshot?.matches.length).toBeGreaterThan(0);
    expect(snapshot?.matches[0]?.sessionId).toBe("s-1");
  });

  it("returns undefined for unrelated queries", async () => {
    const snapshot = await provider.resolve("xenomorph blueberry hyperdrive");
    expect(snapshot).toBeUndefined();
  });

  it("filters by userId when episodes are user-scoped", async () => {
    const scoped = new InMemoryEpisodicRecallProvider({
      episodes: [
        { narrative: "user one secret note about JARVIS", sessionId: "s-a", userId: "u1" },
        { narrative: "user two secret note about JARVIS", sessionId: "s-b", userId: "u2" }
      ],
      minScore: 0.05
    });
    const snapshot = await scoped.resolve("JARVIS", "u1");
    expect(snapshot?.matches).toHaveLength(1);
    expect(snapshot?.matches[0]?.sessionId).toBe("s-a");
  });
});

describe("renderEpisodicSection", () => {
  it("returns undefined when no matches", () => {
    expect(renderEpisodicSection(undefined)).toBeUndefined();
    expect(renderEpisodicSection({ matches: [] })).toBeUndefined();
  });

  it("renders a header and narratives", () => {
    const rendered = renderEpisodicSection({
      matches: [
        { createdAtIso: "2026-05-10T00:00:00Z", narrative: "Past JARVIS chat", sessionId: "s-1", similarity: 0.4 }
      ]
    });
    expect(rendered).toContain("[Episodic Memory]");
    expect(rendered).toContain("Past JARVIS chat");
    expect(rendered).toContain("0.40");
  });
});
