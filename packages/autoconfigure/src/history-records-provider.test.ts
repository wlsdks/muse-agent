import { describe, expect, it } from "vitest";

import { buildHistoryRecords } from "./history-records-provider.js";

const episodes = [
  { id: "ep-1", userId: "u1", summary: "We discussed the VPN MTU fix.", endedAt: "2026-06-20T10:00:00Z" },
  { id: "ep-other", userId: "u2", summary: "Someone else's session." }
];

describe("buildHistoryRecords — record sources + optional embedding (A2)", () => {
  it("collects the user's own episodes as labelled history records", async () => {
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1" });
    expect(records.map((r) => r.ref)).toEqual(["ep-1"]);
    expect(records[0]!.source).toBe("episodes");
    expect(records[0]!.embedding).toBeUndefined();
  });

  it("attaches an embedding to each record when an embedder is injected", async () => {
    const embed = (text: string): Promise<readonly number[]> => Promise.resolve([text.length, 0, 1]);
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1", embed });
    expect(records).toHaveLength(1);
    expect(records[0]!.embedding).toEqual([episodes[0]!.summary.length, 0, 1]);
  });

  it("per-record fail-soft: a thrown embed leaves that record lexical-only, never drops it", async () => {
    const embed = (): Promise<readonly number[]> => Promise.reject(new Error("ollama down"));
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1", embed });
    expect(records.map((r) => r.ref)).toEqual(["ep-1"]);
    expect(records[0]!.embedding).toBeUndefined();
  });

  it("drops an empty embedding rather than attaching a useless zero-length vector", async () => {
    const embed = (): Promise<readonly number[]> => Promise.resolve([]);
    const records = await buildHistoryRecords({ readEpisodes: () => episodes, userId: "u1", embed });
    expect(records[0]!.embedding).toBeUndefined();
  });
});
