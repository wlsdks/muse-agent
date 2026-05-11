import { describe, expect, it } from "vitest";

import {
  StoreBackedEpisodicRecallProvider,
  type SummaryListSource
} from "../src/episodic-recall.js";

function makeStore(summaries: ReadonlyArray<{
  sessionId: string;
  narrative: string;
  createdAt?: Date;
  userId?: string;
}>): SummaryListSource {
  return {
    listAll(options?: { readonly userId?: string; readonly limit?: number }) {
      const filtered = options?.userId
        ? summaries.filter((entry) => entry.userId === options.userId)
        : summaries;
      const limit = options?.limit ?? 200;
      return filtered.slice(0, limit);
    }
  };
}

describe("StoreBackedEpisodicRecallProvider", () => {
  const store = makeStore([
    {
      createdAt: new Date("2026-05-10T00:00:00Z"),
      narrative: "Decided to use Kysely for DB access; Prisma rejected for build-time cost",
      sessionId: "s-1",
      userId: "u1"
    },
    {
      createdAt: new Date("2026-05-09T00:00:00Z"),
      narrative: "Slack integration design and inbox-store schema review",
      sessionId: "s-2",
      userId: "u1"
    },
    {
      createdAt: new Date("2026-05-08T00:00:00Z"),
      narrative: "user two unrelated session about chess strategy",
      sessionId: "s-3",
      userId: "u2"
    }
  ]);

  it("surfaces matching past sessions by Jaccard overlap", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({ minScore: 0.05, store });
    // Use distinctive content tokens; stopwords like "about" / "we" are
    // a known Jaccard weakness — tests should pick tokens specific to
    // the target session so the score is dominated by signal, not noise.
    const snapshot = await provider.resolve("Kysely Prisma DB build decision");
    expect(snapshot?.matches[0]?.sessionId).toBe("s-1");
  });

  it("scopes results by userId", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({ minScore: 0.05, store });
    const u1 = await provider.resolve("chess strategy session", "u1");
    expect(u1).toBeUndefined();
    const u2 = await provider.resolve("chess strategy", "u2");
    expect(u2?.matches[0]?.sessionId).toBe("s-3");
  });

  it("returns undefined when the store does not expose listAll", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({ store: {} });
    expect(await provider.resolve("anything")).toBeUndefined();
  });

  it("returns undefined for empty queries", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({ store });
    expect(await provider.resolve("")).toBeUndefined();
  });

  it("fail-opens when listAll throws", async () => {
    const provider = new StoreBackedEpisodicRecallProvider({
      store: {
        listAll() {
          throw new Error("db down");
        }
      }
    });
    expect(await provider.resolve("Kysely decision")).toBeUndefined();
  });
});
