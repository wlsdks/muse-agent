import { describe, expect, it } from "vitest";

import {
  InMemoryFeedbackStore,
  InMemoryPromptLabCatalogStore,
  InMemoryPromptLabExperimentStore,
  applySystemPrompt,
  createPromptExperiment,
  createPromptVariant,
  rankPromptVariants
} from "../src/index.js";

describe("createPromptVariant", () => {
  it("auto-generates an id when none is supplied and defaults metadata to {}", () => {
    const variant = createPromptVariant({
      name: "alpha",
      systemPrompt: "You are alpha."
    });
    expect(variant.id).toMatch(/^prompt_variant_/u);
    expect(variant.metadata).toEqual({});
    expect(variant.name).toBe("alpha");
    expect(variant.systemPrompt).toBe("You are alpha.");
  });

  it("preserves a caller-supplied id and metadata", () => {
    const variant = createPromptVariant({
      id: "custom-id",
      metadata: { tag: "control" },
      name: "beta",
      systemPrompt: "You are beta."
    });
    expect(variant.id).toBe("custom-id");
    expect(variant.metadata).toEqual({ tag: "control" });
  });
});

describe("createPromptExperiment", () => {
  it("auto-generates an id and defaults metadata", () => {
    const experiment = createPromptExperiment({
      cases: [{ id: "c1", input: "x" }],
      model: "diagnostic/smoke",
      name: "exp",
      variants: [createPromptVariant({ name: "a", systemPrompt: "p" })]
    });
    expect(experiment.id).toMatch(/^prompt_experiment_/u);
    expect(experiment.metadata).toEqual({});
    expect(experiment.cases).toHaveLength(1);
    expect(experiment.variants).toHaveLength(1);
  });

  it("preserves caller-supplied id and metadata", () => {
    const experiment = createPromptExperiment({
      cases: [],
      id: "exp-1",
      metadata: { hypothesis: "shorter is better" },
      model: "m",
      name: "exp",
      variants: []
    });
    expect(experiment.id).toBe("exp-1");
    expect(experiment.metadata).toEqual({ hypothesis: "shorter is better" });
  });
});

describe("rankPromptVariants", () => {
  it("averages judge scores per variant and sorts descending", () => {
    const ranked = rankPromptVariants([
      { caseId: "c1", judge: { passed: true, score: 0.8 }, output: "o", variantId: "a" },
      { caseId: "c2", judge: { passed: true, score: 0.6 }, output: "o", variantId: "a" },
      { caseId: "c1", judge: { passed: true, score: 0.9 }, output: "o", variantId: "b" },
      { caseId: "c2", judge: { passed: true, score: 0.9 }, output: "o", variantId: "b" }
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toEqual({ averageScore: 0.9, total: 2, variantId: "b" });
    expect(ranked[1]?.variantId).toBe("a");
    expect(ranked[1]?.total).toBe(2);
    expect(ranked[1]?.averageScore).toBeCloseTo(0.7, 10);
  });

  it("treats a missing judge score as 0 and counts it in the total", () => {
    const ranked = rankPromptVariants([
      { caseId: "c1", output: "o", variantId: "a" },
      { caseId: "c2", judge: { passed: true, score: 1 }, output: "o", variantId: "a" }
    ]);
    expect(ranked).toEqual([{ averageScore: 0.5, total: 2, variantId: "a" }]);
  });

  it("returns an empty array when no results are supplied", () => {
    expect(rankPromptVariants([])).toEqual([]);
  });
});

describe("applySystemPrompt", () => {
  it("prepends a synthetic system message when no system message exists", () => {
    expect(applySystemPrompt([{ content: "hi", role: "user" }], "you are jarvis")).toEqual([
      { content: "you are jarvis", role: "system" },
      { content: "hi", role: "user" }
    ]);
  });

  it("merges into the existing first system message", () => {
    expect(
      applySystemPrompt(
        [
          { content: "be concise", role: "system" },
          { content: "task", role: "user" }
        ],
        "you are jarvis"
      )
    ).toEqual([
      { content: "you are jarvis\n\nbe concise", role: "system" },
      { content: "task", role: "user" }
    ]);
  });

  it("returns just the synthetic system message for an empty input", () => {
    expect(applySystemPrompt([], "p")).toEqual([{ content: "p", role: "system" }]);
  });
});

describe("InMemoryFeedbackStore", () => {
  it("auto-generates a feedback id when missing and round-trips by get/list", () => {
    const store = new InMemoryFeedbackStore();
    const saved = store.save({ rating: 5, comment: "great" }) as { id: string };
    expect(saved.id).toMatch(/^feedback_/u);
    expect(store.get(saved.id)).toMatchObject({ rating: 5, comment: "great" });
    expect(store.list()).toHaveLength(1);
  });

  it("preserves a caller-supplied id and supports delete", () => {
    const store = new InMemoryFeedbackStore();
    const saved = store.save({ id: "fb-1", rating: 3 }) as { id: string };
    expect(saved.id).toBe("fb-1");
    expect(store.delete("fb-1")).toBe(true);
    expect(store.delete("fb-1")).toBe(false);
    expect(store.get("fb-1")).toBeUndefined();
  });
});

describe("InMemoryPromptLabExperimentStore", () => {
  it("auto-generates an experiment id and stores it for retrieval", () => {
    const store = new InMemoryPromptLabExperimentStore();
    const saved = store.saveExperiment({ name: "exp" }) as { id: string };
    expect(saved.id).toMatch(/^prompt_experiment_/u);
    expect(store.getExperiment(saved.id)).toMatchObject({ name: "exp" });
    expect(store.listExperiments()).toHaveLength(1);
  });

  it("saveTrials replaces the stored trials and tags each with the experimentId", () => {
    const store = new InMemoryPromptLabExperimentStore();
    store.saveTrials("exp-1", [{ caseId: "c1" }, { caseId: "c2" }]);
    const trials = store.listTrials("exp-1");
    expect(trials).toHaveLength(2);
    expect(trials.every((trial) => trial.experimentId === "exp-1")).toBe(true);
    // Replacement: a second saveTrials call wipes the previous batch.
    store.saveTrials("exp-1", [{ caseId: "c3" }]);
    expect(store.listTrials("exp-1")).toHaveLength(1);
  });

  it("saveReport defaults id to experimentId and getReport returns it", () => {
    const store = new InMemoryPromptLabExperimentStore();
    const saved = store.saveReport("exp-1", { winnerVariantId: "a" }) as { id: string };
    expect(saved.id).toBe("exp-1");
    expect(store.getReport("exp-1")).toMatchObject({ winnerVariantId: "a" });
  });

  it("deleteExperiment cascades to reports and trials", () => {
    const store = new InMemoryPromptLabExperimentStore();
    store.saveExperiment({ id: "exp-1", name: "exp" });
    store.saveTrials("exp-1", [{ caseId: "c1" }]);
    store.saveReport("exp-1", { winnerVariantId: "a" });
    expect(store.deleteExperiment("exp-1")).toBe(true);
    expect(store.getExperiment("exp-1")).toBeUndefined();
    expect(store.getReport("exp-1")).toBeUndefined();
    expect(store.listTrials("exp-1")).toEqual([]);
    // Second delete returns false.
    expect(store.deleteExperiment("exp-1")).toBe(false);
  });

  it("listTrials for an unknown experiment returns an empty array", () => {
    const store = new InMemoryPromptLabExperimentStore();
    expect(store.listTrials("never-saved")).toEqual([]);
  });
});

describe("InMemoryPromptLabCatalogStore", () => {
  it("savePersona auto-fills id, createdAt, updatedAt and round-trips by id", () => {
    const store = new InMemoryPromptLabCatalogStore();
    const saved = store.savePersona({ name: "alpha" }) as {
      id: string;
      createdAt: string;
      updatedAt: string;
    };
    expect(saved.id).toMatch(/^persona_/u);
    expect(saved.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(store.getPersona(saved.id)).toMatchObject({ name: "alpha" });
  });

  it("getPersona falls back to looking up by name when id misses", () => {
    const store = new InMemoryPromptLabCatalogStore();
    store.savePersona({ id: "p-1", name: "byname" });
    expect(store.getPersona("p-1")).toMatchObject({ name: "byname" });
    expect(store.getPersona("byname")).toMatchObject({ id: "p-1" });
    expect(store.getPersona("nope")).toBeUndefined();
  });

  it("deletePersona removes by id or by name", () => {
    const store = new InMemoryPromptLabCatalogStore();
    store.savePersona({ id: "p-1", name: "alpha" });
    expect(store.deletePersona("alpha")).toBe(true);
    expect(store.getPersona("p-1")).toBeUndefined();
    expect(store.deletePersona("alpha")).toBe(false);
  });

  it("saveTemplate / getTemplate / deleteTemplate parallel persona behavior", () => {
    const store = new InMemoryPromptLabCatalogStore();
    const template = store.saveTemplate({ name: "tmpl" }) as { id: string };
    expect(template.id).toMatch(/^prompt_template_/u);
    expect(store.getTemplate("tmpl")?.id).toBe(template.id);
    expect(store.deleteTemplate(template.id)).toBe(true);
  });

  it("saveIntent uses the intent name as the id", () => {
    const store = new InMemoryPromptLabCatalogStore();
    const saved = store.saveIntent({ name: "summarise", description: "summarise the input" }) as {
      id: string;
      name: string;
    };
    expect(saved.id).toBe("summarise");
    expect(saved.name).toBe("summarise");
    expect(store.getIntent("summarise")).toMatchObject({ description: "summarise the input" });
    expect(store.deleteIntent("summarise")).toBe(true);
    expect(store.deleteIntent("summarise")).toBe(false);
  });
});
