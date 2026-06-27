import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { notesGroundingFraming, type ScoredChunk } from "./chunks.js";

// A top chunk whose cosine sits BETWEEN the conformal-calibrated stricter bar
// (0.62) and the hardcoded default (0.55), with the runner-up far below so the
// margin guard never fires. Only the resolved `confidentAt` decides the verdict.
const chunk = (file: string, text: string, score: number): ScoredChunk => ({
  chunk: { chunkIndex: 0, embedding: [], file, text },
  file,
  score
});

const verdictSet: readonly ScoredChunk[] = [
  chunk("vpn.md", "office vpn mtu 1380 seoul tunnel handshake", 0.57),
  chunk("misc.md", "grocery milk eggs bread", 0.3)
];

describe("notesGroundingFraming honors the conformal-calibrated MUSE_GROUNDING_MIN_COSINE (RGV entry point)", () => {
  const original = process.env.MUSE_GROUNDING_MIN_COSINE;
  beforeEach(() => {
    delete process.env.MUSE_GROUNDING_MIN_COSINE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MUSE_GROUNDING_MIN_COSINE;
    else process.env.MUSE_GROUNDING_MIN_COSINE = original;
  });

  it("no env override → confident at the 0.55 default (fabrication=0 floor unchanged)", () => {
    expect(notesGroundingFraming(verdictSet).verdict).toBe("confident");
  });

  it("a stricter calibrated env value raises the abstention bar → ambiguous", () => {
    process.env.MUSE_GROUNDING_MIN_COSINE = "0.62";
    expect(notesGroundingFraming(verdictSet).verdict).toBe("ambiguous");
  });

  it("a garbage env value is ignored → stays confident (fail-safe)", () => {
    process.env.MUSE_GROUNDING_MIN_COSINE = "not-a-number";
    expect(notesGroundingFraming(verdictSet).verdict).toBe("confident");
  });

  it("v2-moe embedder: a genuine sub-0.55 match the nomic bar over-abstains on is now confident", () => {
    // A real v2-moe match at 0.49 with a far runner-up (no lexical overlap, so the
    // strongLexical upgrade can't fire — only the calibrated cosine bar decides).
    const subBar: readonly ScoredChunk[] = [
      chunk("policy.md", "renewal date and premium figures for the coverage", 0.49),
      chunk("misc.md", "unrelated grocery jottings", 0.24)
    ];
    expect(notesGroundingFraming(subBar, undefined, undefined, "nomic-embed-text").verdict).toBe("ambiguous");
    expect(notesGroundingFraming(subBar, undefined, undefined, "nomic-embed-text-v2-moe").verdict).toBe("confident");
  });

  it("v2-moe embedder: an absent-like top (≤0.415) STILL abstains — fabrication-safe", () => {
    const absent: readonly ScoredChunk[] = [
      chunk("car.md", "car inspection and plate details", 0.40),
      chunk("misc.md", "unrelated", 0.20)
    ];
    expect(notesGroundingFraming(absent, undefined, undefined, "nomic-embed-text-v2-moe").verdict).toBe("ambiguous");
  });
});
