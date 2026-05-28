import { describe, expect, it } from "vitest";

import { reorderForLongContext } from "./commands-ask.js";

const item = (id: string, score: number) => ({ id, score });

describe("reorderForLongContext — Lost in the Middle (Liu et al. 2023)", () => {
  it("places the most relevant at the start and the second-most at the end", () => {
    const out = reorderForLongContext([item("c", 0.7), item("a", 0.9), item("e", 0.5), item("b", 0.8), item("d", 0.6)]);
    expect(out[0]?.id).toBe("a"); // rank 1 → start
    expect(out[out.length - 1]?.id).toBe("b"); // rank 2 → end
  });

  it("buries the least relevant in the middle, never at an edge", () => {
    const out = reorderForLongContext([item("a", 0.9), item("b", 0.8), item("c", 0.7), item("d", 0.6), item("e", 0.5)]);
    const minId = "e";
    expect(out[0]?.id).not.toBe(minId);
    expect(out[out.length - 1]?.id).not.toBe(minId);
    // exact edge-placed order for sorted [.9 .8 .7 .6 .5]: front=[.9 .7 .5], back rev=[.6 .8]
    expect(out.map((o) => o.id)).toEqual(["a", "c", "e", "d", "b"]);
  });

  it("does not assume the input is pre-sorted (ranks by score itself)", () => {
    const out = reorderForLongContext([item("low", 0.1), item("high", 0.99), item("mid", 0.5)]);
    expect(out[0]?.id).toBe("high");
  });

  it("is a no-op for 0 or 1 items", () => {
    expect(reorderForLongContext([])).toEqual([]);
    expect(reorderForLongContext([item("solo", 0.5)]).map((o) => o.id)).toEqual(["solo"]);
  });

  it("two items: best leads, next trails", () => {
    expect(reorderForLongContext([item("b", 0.4), item("a", 0.8)]).map((o) => o.id)).toEqual(["a", "b"]);
  });
});
