import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_REINDEX_EMBED_TIMEOUT_MS,
  DEFAULT_AUTO_REINDEX_MAX_EMBEDDINGS,
  autoReindexBudgetEnvironment,
  resolveAutoReindexBudget
} from "./auto-reindex-budget.js";

describe("resolveAutoReindexBudget", () => {
  it("uses small safe defaults", () => {
    expect(resolveAutoReindexBudget({})).toEqual({ embedTimeoutMs: 5_000, maxEmbeddingAttempts: 1 });
  });

  it("persists only valid explicit resident overrides", () => {
    expect(autoReindexBudgetEnvironment({ MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS: "8000", MUSE_AUTO_REINDEX_MAX_EMBEDDINGS: "3" }))
      .toEqual({ MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS: "8000", MUSE_AUTO_REINDEX_MAX_EMBEDDINGS: "3" });
    expect(autoReindexBudgetEnvironment({ MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS: " 8000 ", MUSE_AUTO_REINDEX_MAX_EMBEDDINGS: "0" })).toEqual({});
  });

  it("accepts only exact decimal integers in range", () => {
    expect(resolveAutoReindexBudget({ MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS: "30000", MUSE_AUTO_REINDEX_MAX_EMBEDDINGS: "64" }))
      .toEqual({ embedTimeoutMs: 30_000, maxEmbeddingAttempts: 64 });
    for (const raw of ["0", " 2 ", "1e1", "65", "bad"]) {
      expect(resolveAutoReindexBudget({ MUSE_AUTO_REINDEX_MAX_EMBEDDINGS: raw }).maxEmbeddingAttempts).toBe(DEFAULT_AUTO_REINDEX_MAX_EMBEDDINGS);
    }
    for (const raw of ["0", " 5000 ", "5e3", "30001", "bad"]) {
      expect(resolveAutoReindexBudget({ MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS: raw }).embedTimeoutMs).toBe(DEFAULT_AUTO_REINDEX_EMBED_TIMEOUT_MS);
    }
  });
});
