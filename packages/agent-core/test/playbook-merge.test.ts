import { describe, expect, it } from "vitest";

import { clusterByTextSimilarity, deltaMergePlaybookStrategies, mergePlaybookStrategies } from "../src/playbook-merge.js";

function fakeProvider(output: string) {
  return { generate: async () => ({ output }) } as unknown as Parameters<typeof mergePlaybookStrategies>[1]["modelProvider"];
}

// Trivial token-overlap similarity for the clusterer test.
function jaccard(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/u));
  const sb = new Set(b.toLowerCase().split(/\s+/u));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

describe("deltaMergePlaybookStrategies (ACE deterministic delta-merge)", () => {
  it("returns undefined for empty input", () => {
    expect(deltaMergePlaybookStrategies([])).toBeUndefined();
  });

  it("returns undefined for a single-element input", () => {
    expect(deltaMergePlaybookStrategies(["only one"])).toBeUndefined();
  });

  it("collapses whitespace-variant duplicates to the normalized form", () => {
    expect(deltaMergePlaybookStrategies(["clean up the logs", "clean up   the    logs"])).toBe("clean up the logs");
  });

  it("keeps the more-specific (longer-token) strategy and drops the less-specific one", () => {
    const result = deltaMergePlaybookStrategies(["log errors", "log errors carefully and promptly every time"]);
    expect(result).toBe("log errors carefully and promptly every time");
  });

  it("returns undefined when strategies are genuinely distinct (anti-collapse: NONE)", () => {
    expect(deltaMergePlaybookStrategies(["batch the database writes", "validate all user input"])).toBeUndefined();
  });

  it("returns the shared string when all inputs are identical", () => {
    expect(deltaMergePlaybookStrategies(["do X", "do X"])).toBe("do X");
  });

  it("ANTI-COLLAPSE INVARIANT: survivor token-covers every input that yielded a string", () => {
    function coversAllWords(survivor: string, inputs: readonly string[]): boolean {
      const survivorLower = survivor.toLowerCase();
      for (const input of inputs) {
        const tokens = input.toLowerCase().split(/\s+/u).filter(Boolean);
        for (const token of tokens) {
          if (!survivorLower.includes(token)) return false;
        }
      }
      return true;
    }

    const testSets: [readonly string[], string][] = [
      [["clean up the logs", "clean up   the    logs"], "whitespace-variant duplicates"],
      [["log errors", "log errors carefully and promptly every time"], "subsumption (short vs long)"],
      [["sort items", "sort items by date", "sort items by date ascending"], "3-element chain"],
    ];

    for (const [inputs, label] of testSets) {
      const result = deltaMergePlaybookStrategies(inputs);
      if (result !== undefined) {
        expect(coversAllWords(result, inputs), `invariant failed for: ${label}`).toBe(true);
      }
    }
  });
});

describe("clusterByTextSimilarity", () => {
  it("groups similar items, leaves a distinct one alone", () => {
    const items = ["use bullet points when summarising", "use bullets when summarising", "default to next business day when rescheduling"];
    const clusters = clusterByTextSimilarity(items, (s) => s, jaccard, 0.5);
    const sizes = clusters.map((c) => c.length).sort();
    expect(sizes).toEqual([1, 2]);
  });
});

describe("mergePlaybookStrategies", () => {
  it("returns the merged strategy, stripping a stray prefix/quotes", async () => {
    const out = await mergePlaybookStrategies(["use bullets for summaries", "summaries should be bullet points"], {
      model: "qwen3:8b",
      modelProvider: fakeProvider('strategy: "When summarising, use bullet points."')
    });
    expect(out).toBe("When summarising, use bullet points.");
  });
  it("returns undefined on NONE, on <2, and on error", async () => {
    expect(await mergePlaybookStrategies(["a", "b"], { model: "m", modelProvider: fakeProvider("NONE") })).toBeUndefined();
    expect(await mergePlaybookStrategies(["only one"], { model: "m", modelProvider: fakeProvider("x") })).toBeUndefined();
    const thrower = { generate: async () => { throw new Error("offline"); } } as unknown as Parameters<typeof mergePlaybookStrategies>[1]["modelProvider"];
    expect(await mergePlaybookStrategies(["a", "b"], { model: "m", modelProvider: thrower })).toBeUndefined();
  });
});
