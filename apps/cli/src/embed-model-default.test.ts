import { describe, expect, it } from "vitest";

import { DEFAULT_EMBED_MODEL, LEGACY_EMBED_MODEL, resolveIndexModel } from "./embed-model-default.js";

describe("embed model default + legacy index migration", () => {
  it("the shipped default is the multilingual embedder, not the legacy one", () => {
    expect(DEFAULT_EMBED_MODEL).toBe("nomic-embed-text-v2-moe");
    expect(LEGACY_EMBED_MODEL).toBe("nomic-embed-text");
  });

  it("migrates a legacy-default index to the new default (one-time upgrade)", () => {
    expect(resolveIndexModel(LEGACY_EMBED_MODEL, DEFAULT_EMBED_MODEL)).toBe(DEFAULT_EMBED_MODEL);
  });

  it("preserves an explicitly chosen custom index model", () => {
    expect(resolveIndexModel("mxbai-embed-large", DEFAULT_EMBED_MODEL)).toBe("mxbai-embed-large");
  });

  it("keeps the legacy model when the caller explicitly requested it", () => {
    expect(resolveIndexModel(LEGACY_EMBED_MODEL, LEGACY_EMBED_MODEL)).toBe(LEGACY_EMBED_MODEL);
  });

  it("a missing index model falls back to the requested one", () => {
    expect(resolveIndexModel(undefined, DEFAULT_EMBED_MODEL)).toBe(DEFAULT_EMBED_MODEL);
    expect(resolveIndexModel("  ", "anything")).toBe("anything");
  });
});
