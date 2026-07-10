import { describe, expect, it } from "vitest";

import { reorderForLongContext } from "@muse/agent-core";
import { demoteStale } from "@muse/recall";

function chunk(file: string, text: string, score: number) {
  return { chunk: { chunkIndex: 0, embedding: [], file, text }, file, score };
}

describe("commands-ask's reorderForLongContext → demoteStale composition (litm re-sort would undo a naive demotion)", () => {
  const stale = chunk("rent_old.md", "예전에 월세 120만원이었는데 지금은 아니다.", 0.95);
  const current = chunk("rent_new.md", "월세 125만원", 0.7);

  it("reorderForLongContext ALONE puts the higher-scoring stale chunk back in front (the regression this composition guards against)", () => {
    const litmOnly = reorderForLongContext([stale, current]);
    expect(litmOnly[0]?.file).toBe("rent_old.md");
  });

  it("demoteStale applied AFTER reorderForLongContext restores the current chunk to top-1", () => {
    const contextChunks = demoteStale(reorderForLongContext([stale, current]), (c) => c.chunk.text);
    expect(contextChunks[0]?.file).toBe("rent_new.md");
    expect(contextChunks.map((c) => c.file)).toEqual(["rent_new.md", "rent_old.md"]); // demoted, never dropped
  });
});
