import { describe, expect, it } from "vitest";

import { isModelResident, isModelResidentLive, parseResidentModels } from "./model-resident.js";

describe("parseResidentModels — read loaded models from /api/ps", () => {
  it("collects name + model fields, deduped", () => {
    expect(parseResidentModels({ models: [{ name: "qwen3:8b", model: "qwen3:8b" }, { name: "nomic-embed-text:latest" }] }))
      .toEqual(["qwen3:8b", "nomic-embed-text:latest"]);
  });

  it("tolerates a missing/!array models field (fail-closed to empty)", () => {
    expect(parseResidentModels({})).toEqual([]);
    expect(parseResidentModels(null)).toEqual([]);
    expect(parseResidentModels({ models: "nope" })).toEqual([]);
  });
});

describe("isModelResident — provider prefix + tag aware", () => {
  it("matches ignoring a provider/ prefix", () => {
    expect(isModelResident("ollama/qwen3:8b", ["qwen3:8b"])).toBe(true);
    expect(isModelResident("qwen3:8b", ["qwen3:8b", "nomic-embed-text:latest"])).toBe(true);
  });

  it("does not match a different model / empty resident set", () => {
    expect(isModelResident("qwen3:8b", ["llama3:70b"])).toBe(false);
    expect(isModelResident("qwen3:8b", [])).toBe(false);
  });
});

describe("isModelResidentLive — fail-closed probe", () => {
  const okFetch = (body: unknown): typeof globalThis.fetch =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof globalThis.fetch;

  it("true when /api/ps lists the model", async () => {
    expect(await isModelResidentLive("ollama/qwen3:8b", "http://x:11434", okFetch({ models: [{ name: "qwen3:8b" }] }))).toBe(true);
  });

  it("false when the model is not resident", async () => {
    expect(await isModelResidentLive("qwen3:8b", "http://x:11434", okFetch({ models: [] }))).toBe(false);
  });

  it("false (fail-closed) when the request throws or is not OK", async () => {
    const throwFetch = (async () => { throw new Error("connection refused"); }) as unknown as typeof globalThis.fetch;
    expect(await isModelResidentLive("qwen3:8b", "http://x:11434", throwFetch)).toBe(false);
    const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
    expect(await isModelResidentLive("qwen3:8b", "http://x:11434", notOk)).toBe(false);
  });
});
