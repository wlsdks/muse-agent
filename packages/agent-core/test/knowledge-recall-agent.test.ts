import { ToolRegistry, validateToolDefinitions } from "@muse/tools";
import type { ModelProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  classifyRetrievalConfidence,
  createAgentRuntime,
  createKnowledgeSearchTool,
  edgeLoadByRelevance,
  rankKnowledgeChunks,
  renderKnowledgeMatches,
  type KnowledgeChunk
} from "../src/index.js";

describe("edgeLoadByRelevance — Lost-in-the-Middle context positioning (Liu et al. 2023)", () => {
  it("places the most relevant at the edges (first + last), least in the middle", () => {
    // best-first [a,b,c,d,e] → a first, b last, the weakest (e) buried mid
    expect(edgeLoadByRelevance(["a", "b", "c", "d", "e"])).toEqual(["a", "c", "e", "d", "b"]);
    expect(edgeLoadByRelevance(["a", "b"])).toEqual(["a", "b"]);
    expect(edgeLoadByRelevance(["a"])).toEqual(["a"]);
    expect(edgeLoadByRelevance([])).toEqual([]);
  });
});

// Deterministic local "embedding": presence of each vocab term. Stands
// in for Ollama's embedder — the REAL cosine-ranking code path runs.
const VOCAB = ["allergic", "peanut", "shellfish", "insurance", "policy", "home"];
const embed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((term) => (lower.includes(term) ? 1 : 0));
};

const CORPUS: readonly KnowledgeChunk[] = [
  { source: "notes/health.md", text: "Jinan is allergic to peanuts and shellfish." },
  { source: "notes/old.md", text: "peanut butter recipe" },
  { source: "docs/insurance.pdf", text: "The home insurance policy number is HOME-99812." }
];

describe("createKnowledgeSearchTool — definition meets the one-shot tool-calling bar", () => {
  it("its query parameter is described (validateToolDefinitions clean)", () => {
    const tool = createKnowledgeSearchTool({ corpus: CORPUS, embed });
    expect(validateToolDefinitions([tool])).toEqual([]);
    const props = (tool.definition.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.query.description ?? "").toContain("e.g.");
  });
});

describe("rankKnowledgeChunks", () => {
  it("hybrid RRF recalls an exact-keyword chunk that pure cosine drops (Cormack et al. 2009)", async () => {
    // embed vocab has the semantic term "alpha" but NOT the rare token
    // "e2099" — so the exact-keyword chunk has zero cosine and pure
    // cosine never returns it; lexical overlap + RRF must recall it.
    const vocab = ["alpha", "beta", "gamma"];
    const termEmbed = async (text: string): Promise<readonly number[]> => {
      const lower = text.toLowerCase();
      return vocab.map((term) => (lower.includes(term) ? 1 : 0));
    };
    const corpus: readonly KnowledgeChunk[] = [
      { source: "decoy.md", text: "alpha beta gamma overview" },
      { source: "answer.md", text: "ticket E2099 resolution steps" }
    ];

    const cosineOnly = await rankKnowledgeChunks("alpha E2099", corpus, { embed: termEmbed, topK: 5 });
    expect(cosineOnly.map((m) => m.source)).not.toContain("answer.md");

    const hybrid = await rankKnowledgeChunks("alpha E2099", corpus, { embed: termEmbed, hybrid: true, topK: 5 });
    expect(hybrid.map((m) => m.source)).toContain("answer.md");
  });

  it("MMR diversifies top-K so a near-duplicate doesn't crowd out a distinct relevant passage (Carbonell & Goldstein 1998)", async () => {
    const vocab = ["x", "y", "z"];
    const termEmbed = async (text: string): Promise<readonly number[]> => {
      const lower = text.toLowerCase();
      return vocab.map((term) => (lower.includes(term) ? 1 : 0));
    };
    // dupeA/dupeB embed identically ([1,1,0]); distinct is [0,0,1] —
    // lower relevance to "x y z" but orthogonal to the dupes.
    const corpus: readonly KnowledgeChunk[] = [
      { source: "dupeA.md", text: "x y" },
      { source: "dupeB.md", text: "x y" },
      { source: "distinct.md", text: "z" }
    ];

    const plain = await rankKnowledgeChunks("x y z", corpus, { embed: termEmbed, topK: 2 });
    expect(plain.map((m) => m.source)).toEqual(["dupeA.md", "dupeB.md"]);

    // No explicit mmrLambda → pins the default (0.5), which live
    // measurement showed is needed to drop a real near-duplicate.
    const diverse = await rankKnowledgeChunks("x y z", corpus, { diversify: true, embed: termEmbed, topK: 2 });
    expect(diverse.map((m) => m.source)).toContain("distinct.md");
    expect(diverse.map((m) => m.source)).not.toContain("dupeB.md");
  });

  it("ranks multi-source chunks by similarity, keeps the source, drops sub-threshold passages", async () => {
    const matches = await rankKnowledgeChunks("allergic to peanuts", CORPUS, { embed });
    expect(matches.map((m) => m.source)).toEqual(["notes/health.md", "notes/old.md"]);
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
    // insurance.pdf shares no terms with the query → filtered out, no fabricated citation.
    expect(matches.some((m) => m.source === "docs/insurance.pdf")).toBe(false);
  });

  it("returns nothing for an empty query or empty corpus", async () => {
    expect(await rankKnowledgeChunks("", CORPUS, { embed })).toEqual([]);
    expect(await rankKnowledgeChunks("allergic", [], { embed })).toEqual([]);
  });
});

describe("classifyRetrievalConfidence — CRAG verdict (arXiv 2401.15884)", () => {
  const m = (cosine: number) => ({ cosine, score: 0.02, source: "s", text: "t" });

  it("none when there are no matches", () => {
    expect(classifyRetrievalConfidence([])).toBe("none");
  });

  it("confident when the top cosine clears the bar", () => {
    expect(classifyRetrievalConfidence([m(0.6), m(0.2)])).toBe("confident");
  });

  it("ambiguous when the top cosine is present but below the confident bar", () => {
    expect(classifyRetrievalConfidence([m(0.2)])).toBe("ambiguous");
  });

  it("honours a custom confidentAt", () => {
    expect(classifyRetrievalConfidence([m(0.6)], { confidentAt: 0.8 })).toBe("ambiguous");
  });

  it("falls back to the score when cosine is absent (cosine-path back-compat)", () => {
    expect(classifyRetrievalConfidence([{ score: 0.6, source: "s", text: "t" }])).toBe("confident");
  });

  it("the 0.55 default bar is inclusive (>=): exactly-at-bar is confident, a hair below is ambiguous", () => {
    expect(classifyRetrievalConfidence([m(0.55)])).toBe("confident");
    expect(classifyRetrievalConfidence([m(0.5499)])).toBe("ambiguous");
  });

  it("a non-finite confidentAt (NaN / Infinity from a misconfigured threshold) falls back to the 0.55 default — never breaks the gate", () => {
    // The wedge's trust depends on a real bar; a Number(\"\")=NaN env must not
    // make everything confident or everything ambiguous.
    expect(classifyRetrievalConfidence([m(0.6)], { confidentAt: Number.NaN })).toBe("confident");
    expect(classifyRetrievalConfidence([m(0.3)], { confidentAt: Number.NaN })).toBe("ambiguous");
    expect(classifyRetrievalConfidence([m(0.6)], { confidentAt: Number.POSITIVE_INFINITY })).toBe("confident");
  });

  it("a cosine of exactly 0 is used as the real score (not treated as 'missing' and replaced by score)", () => {
    // `cosine ?? score` only falls back on null/undefined — a genuine 0 cosine
    // stays 0, so a high `score` can't smuggle a zero-similarity match past the bar.
    expect(classifyRetrievalConfidence([{ cosine: 0, score: 0.9, source: "s", text: "t" }])).toBe("ambiguous");
  });
});

describe("rankKnowledgeChunks surfaces the absolute cosine separately from the (RRF) score", () => {
  it("cosine path: cosine equals the score (both are the cosine)", async () => {
    const matches = await rankKnowledgeChunks("allergic to peanuts", CORPUS, { embed, topK: 1 });
    expect(matches[0]!.cosine).toBeCloseTo(matches[0]!.score, 5);
    expect(matches[0]!.cosine!).toBeGreaterThan(0.5);
  });

  it("hybrid path: cosine is the real similarity, score is the small RRF value", async () => {
    const matches = await rankKnowledgeChunks("allergic to peanuts", CORPUS, { embed, hybrid: true, topK: 1 });
    expect(matches[0]!.cosine!).toBeGreaterThan(0.5);
    expect(matches[0]!.score).toBeLessThan(0.1);
  });
});

describe("renderKnowledgeMatches", () => {
  it("labels each passage with its [source] for citation", async () => {
    const matches = await rankKnowledgeChunks("allergic to peanuts", CORPUS, { embed, topK: 1 });
    const rendered = renderKnowledgeMatches(matches);
    expect(rendered).toContain("[notes/health.md]");
    expect(rendered).toContain("allergic to peanuts");
  });

  it("says so when nothing matches (no fabricated source)", () => {
    expect(renderKnowledgeMatches([])).toContain("No matching passages");
  });

  it("frames a weak (ambiguous) match as LOW confidence, not citable (CRAG 2401.15884)", () => {
    const out = renderKnowledgeMatches([{ cosine: 0.2, score: 0.02, source: "notes/x.md", text: "loosely related" }]);
    expect(out).toContain("LOW confidence");
    expect(out).not.toContain("cite the [source]");
    expect(out).toContain("[notes/x.md]");
  });

  it("keeps the citation framing for a confident match", () => {
    const out = renderKnowledgeMatches([{ cosine: 0.7, score: 0.5, source: "notes/x.md", text: "strong match" }]);
    expect(out).toContain("cite the [source]");
  });
});

// Turn 1 calls knowledge_search; turn 2 grounds the answer in the
// tool-result message it received (which carries the [source] label).
function citingProvider(query: string): ModelProvider {
  let turn = 0;
  return {
    id: "fake",
    async generate(request) {
      turn += 1;
      if (turn === 1) {
        return {
          id: "t1",
          model: request.model,
          output: "Let me check your notes.",
          toolCalls: [{ arguments: { query }, id: "tc-1", name: "knowledge_search" }]
        };
      }
      const toolMessage = [...request.messages].reverse().find((message) => message.role === "tool");
      return { id: "t2", model: request.model, output: `According to your records — ${toolMessage?.content ?? "(nothing found)"}` };
    },
    async listModels() {
      return [];
    },
    async *stream() {
      /* unused */
    }
  };
}

describe("P20 knowledge — the agent answers from a multi-doc corpus and CITES the source", () => {
  it("retrieves the relevant document and grounds + attributes the answer", async () => {
    const tool = createKnowledgeSearchTool({ corpus: CORPUS, embed });
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: citingProvider("what am I allergic to?"),
      toolRegistry: new ToolRegistry([tool])
    });

    const result = await runtime.run({
      messages: [{ content: "Search my notes — what am I allergic to?", role: "user" }],
      model: "provider/model",
      runId: "p20-knowledge"
    });

    expect(result.toolsUsed).toContain("knowledge_search");
    // Grounded in the right document's content...
    expect(result.response.output).toContain("peanuts and shellfish");
    // ...AND cites which source it came from.
    expect(result.response.output).toContain("notes/health.md");
    // The unrelated document is not cited.
    expect(result.response.output).not.toContain("insurance.pdf");
  });
});
