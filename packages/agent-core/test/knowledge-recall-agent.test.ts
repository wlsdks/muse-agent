import { ToolRegistry, validateToolDefinitions } from "@muse/tools";
import type { ModelProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  createAgentRuntime,
  createKnowledgeSearchTool,
  rankKnowledgeChunks,
  renderKnowledgeMatches,
  type KnowledgeChunk
} from "../src/index.js";

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

    const diverse = await rankKnowledgeChunks("x y z", corpus, { diversify: true, embed: termEmbed, mmrLambda: 0.5, topK: 2 });
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
