import { describe, expect, it } from "vitest";

import {
  findOllamaModelTag,
  parseNotesIndexEmbedModel,
  type OllamaTagsEntry
} from "./commands-doctor.js";

describe("findOllamaModelTag (goal 101)", () => {
  const models: readonly OllamaTagsEntry[] = [
    { name: "qwen3.5:9b-q4_K_M", size: 6_600_000_000 },
    { name: "qwen2.5:latest", size: 4_700_000_000 },
    { name: "nomic-embed-text:latest", size: 274_000_000 }
  ];

  it("matches an explicit tag verbatim", () => {
    expect(findOllamaModelTag(models, "qwen3.5:9b-q4_K_M")?.size).toBe(6_600_000_000);
  });

  it("treats `<base>` and `<base>:latest` as the same identity (Ollama default tag)", () => {
    expect(findOllamaModelTag(models, "qwen2.5")?.name).toBe("qwen2.5:latest");
    expect(findOllamaModelTag(models, "qwen2.5:latest")?.name).toBe("qwen2.5:latest");
  });

  it("returns undefined for an unpulled tag", () => {
    expect(findOllamaModelTag(models, "qwen3.6:27b")).toBeUndefined();
    expect(findOllamaModelTag(models, "llama4")).toBeUndefined();
  });

  it("trims whitespace on the configured tag (config files often carry stray newlines)", () => {
    expect(findOllamaModelTag(models, "  qwen3.5:9b-q4_K_M  ")?.size).toBe(6_600_000_000);
  });

  it("returns undefined for an empty model list (Ollama up but nothing pulled yet)", () => {
    expect(findOllamaModelTag([], "qwen3.5:9b-q4_K_M")).toBeUndefined();
  });

  it("does NOT match a different tag of the same base (q4 vs q8)", () => {
    expect(findOllamaModelTag(models, "qwen3.5:9b-q8_0")).toBeUndefined();
  });
});

describe("parseNotesIndexEmbedModel (goal 102)", () => {
  it("returns the recorded model when the index carries one", () => {
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "mxbai-embed-large", version: 1 })))
      .toBe("mxbai-embed-large");
  });

  it("falls back to the documented default when the field is missing", () => {
    expect(parseNotesIndexEmbedModel(JSON.stringify({ version: 1 }))).toBe("nomic-embed-text");
  });

  it("falls back to the default on malformed JSON (corrupt index)", () => {
    expect(parseNotesIndexEmbedModel("{ this is not json")).toBe("nomic-embed-text");
  });

  it("returns undefined when no file exists at all (user has not opted into RAG)", () => {
    expect(parseNotesIndexEmbedModel(undefined)).toBeUndefined();
  });

  it("trims whitespace and treats whitespace-only model as missing", () => {
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "  nomic-embed-text  " })))
      .toBe("nomic-embed-text");
    expect(parseNotesIndexEmbedModel(JSON.stringify({ model: "   " }))).toBe("nomic-embed-text");
  });
});
