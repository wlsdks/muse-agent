import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { InMemoryRagDocumentStore } from "@muse/rag";
import {
  composeQueryTransformers,
  createDefaultRagPipeline,
  createDefaultRagQueryTransformer,
  createDocumentStoreRetriever
} from "../src/rag-query.js";

function fakeProvider(generate: (req: ModelRequest) => Promise<ModelResponse>): ModelProvider {
  return {
    id: "fake",
    generate,
    listModels: async () => [],
    stream: async function* () {}
  };
}

describe("composeQueryTransformers", () => {
  it("returns undefined for an empty list", () => {
    expect(composeQueryTransformers([])).toBeUndefined();
  });

  it("returns the only transformer unchanged when length === 1", async () => {
    const transformer = { transform: async () => ["x"] };
    expect(composeQueryTransformers([transformer])).toBe(transformer);
  });

  it("concatenates outputs from multiple transformers and dedupes", async () => {
    const composed = composeQueryTransformers([
      { transform: async () => ["a", "b"] },
      { transform: async () => ["b", "c"] }
    ]);
    const result = await composed!.transform("ignored");
    expect(result).toEqual(["a", "b", "c"]);
  });
});

describe("createDefaultRagQueryTransformer", () => {
  const provider = fakeProvider(async () => ({ id: "r", model: "m", output: "hypothetical doc" }));

  it("returns undefined when no env flags are set", () => {
    expect(createDefaultRagQueryTransformer({
      defaultModel: "test/model",
      env: {},
      modelProvider: provider
    })).toBeUndefined();
  });

  it("returns undefined when flags are set but no model provider is available", () => {
    expect(createDefaultRagQueryTransformer({
      env: { MUSE_RAG_HYDE_ENABLED: "true" }
    })).toBeUndefined();
  });

  it("returns a HyDE-only transformer when only MUSE_RAG_HYDE_ENABLED=true", async () => {
    const transformer = createDefaultRagQueryTransformer({
      defaultModel: "test/model",
      env: { MUSE_RAG_HYDE_ENABLED: "true" },
      modelProvider: provider
    });
    expect(transformer).toBeDefined();
    const out = await transformer!.transform("the original query");
    expect(out).toContain("the original query");
    expect(out).toContain("hypothetical doc");
  });

  it("composes HyDE + Decomposition when both flags are set", async () => {
    const decomposeProvider = fakeProvider(async (req) => ({
      id: "r",
      model: "m",
      output: req.messages.some((m) => m.content.includes("decompose"))
        ? "sub-question 1\nsub-question 2"
        : "hypothetical doc"
    }));
    const transformer = createDefaultRagQueryTransformer({
      defaultModel: "test/model",
      env: { MUSE_RAG_DECOMPOSE_ENABLED: "true", MUSE_RAG_HYDE_ENABLED: "true" },
      modelProvider: decomposeProvider
    });
    expect(transformer).toBeDefined();
    const out = await transformer!.transform("the original query");
    expect(out).toEqual(expect.arrayContaining(["the original query"]));
    expect(out.length).toBeGreaterThan(1);
  });
});

describe("createDocumentStoreRetriever", () => {
  it("re-indexes when the document count changes and returns BM25 hits", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.save({
      content: "Onboarding starts on day one. New hires receive a laptop.",
      metadata: {},
      source: "wiki"
    });
    await store.save({
      content: "Quarterly reviews happen every March.",
      metadata: {},
      source: "wiki"
    });

    const retriever = createDocumentStoreRetriever(store);
    const results = await retriever.retrieve(["onboarding"], 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toContain("Onboarding");
  });

  it("returns empty when the store has no documents", async () => {
    const store = new InMemoryRagDocumentStore();
    const retriever = createDocumentStoreRetriever(store);
    const results = await retriever.retrieve(["anything"], 5);
    expect(results).toEqual([]);
  });
});

describe("createDefaultRagPipeline", () => {
  it("returns undefined when MUSE_RAG_PIPELINE_ENABLED=false explicitly disables RAG", () => {
    expect(createDefaultRagPipeline({
      documentStore: new InMemoryRagDocumentStore(),
      env: { MUSE_RAG_PIPELINE_ENABLED: "false" }
    })).toBeUndefined();
  });

  it("defaults to enabled when MUSE_RAG_PIPELINE_ENABLED is unset (personal-pivot default)", () => {
    expect(createDefaultRagPipeline({
      documentStore: new InMemoryRagDocumentStore(),
      env: {}
    })).toBeDefined();
  });

  it("assembles a working pipeline that retrieves stored documents when enabled", async () => {
    const store = new InMemoryRagDocumentStore();
    await store.save({
      content: "Phoenix is a city in Arizona.",
      metadata: {},
      source: "geography"
    });

    const pipeline = createDefaultRagPipeline({
      documentStore: store,
      env: { MUSE_RAG_PIPELINE_ENABLED: "true" }
    });
    expect(pipeline).toBeDefined();
    const ragContext = await pipeline!.retrieve({ query: "phoenix" });
    expect(ragContext.documents.length).toBeGreaterThan(0);
    expect(ragContext.context).toContain("Phoenix");
  });

  it("returns an empty context when enabled but the document store is empty", async () => {
    const pipeline = createDefaultRagPipeline({
      documentStore: new InMemoryRagDocumentStore(),
      env: { MUSE_RAG_PIPELINE_ENABLED: "true" }
    });
    const ragContext = await pipeline!.retrieve({ query: "anything" });
    expect(ragContext.documents).toEqual([]);
    expect(ragContext.context).toBe("");
  });
});
