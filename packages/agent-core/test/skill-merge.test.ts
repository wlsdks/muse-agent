import { describe, expect, it } from "vitest";

import { mergeSkillsIntoUmbrella } from "../src/skill-merge.js";

const cluster = [
  { name: "summarise-email", description: "Use when summarising an email", body: "1. read 2. 3 bullets" },
  { name: "summarise-doc", description: "Use when summarising a doc", body: "1. skim 2. bullets" }
];

function fakeProvider(output: string) {
  return { generate: async () => ({ output }) } as unknown as Parameters<typeof mergeSkillsIntoUmbrella>[1]["modelProvider"];
}

describe("mergeSkillsIntoUmbrella", () => {
  it("returns the umbrella skill the model composes", async () => {
    const out = await mergeSkillsIntoUmbrella(cluster, {
      model: "qwen3:8b",
      modelProvider: fakeProvider("name: summarise\ndescription: Use when summarising any content\nbody:\n## Steps\n1. read 2. bullets")
    });
    expect(out).toMatchObject({ name: "summarise", description: "Use when summarising any content" });
    expect(out?.body).toContain("Steps");
  });

  it("returns undefined when the model declines (NONE) or the cluster is < 2 or it throws", async () => {
    expect(await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider: fakeProvider("NONE") })).toBeUndefined();
    expect(await mergeSkillsIntoUmbrella([cluster[0]!], { model: "m", modelProvider: fakeProvider("name: x\ndescription: y\nbody:\nz") })).toBeUndefined();
    const thrower = { generate: async () => { throw new Error("offline"); } } as unknown as Parameters<typeof mergeSkillsIntoUmbrella>[1]["modelProvider"];
    expect(await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider: thrower })).toBeUndefined();
  });

  it("returns undefined for an empty cluster too (< 2 guard, the lower bound)", async () => {
    expect(await mergeSkillsIntoUmbrella([], { model: "m", modelProvider: fakeProvider("name: x\ndescription: y\nbody:\nz") })).toBeUndefined();
  });

  it("declines a NONE-prefix verdict and is fail-soft on an undefined model output", async () => {
    expect(await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider: fakeProvider("NONE — these are unrelated") })).toBeUndefined();
    expect(await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider: fakeProvider(undefined as unknown as string) })).toBeUndefined();
  });
});

function capturing() {
  const sink: { request?: { messages: { role: string; content: string }[]; temperature?: number; maxOutputTokens?: number; model: string } } = {};
  const modelProvider = {
    generate: async (request: typeof sink.request) => { sink.request = request; return { output: "NONE" }; }
  } as unknown as Parameters<typeof mergeSkillsIntoUmbrella>[1]["modelProvider"];
  return { modelProvider, sink };
}

describe("mergeSkillsIntoUmbrella — prompt input + request wiring", () => {
  it("numbers each skill from 1 and includes its name, description, and body", async () => {
    const { modelProvider, sink } = capturing();
    await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider });
    const body = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(body).toContain("--- skill 1: summarise-email ---");
    expect(body).toContain("--- skill 2: summarise-doc ---");
    expect(body).toContain("Use when summarising an email");
    expect(body).toContain("1. skim 2. bullets");
  });

  it("redacts secrets in each skill's description AND body before the merge call", async () => {
    const { modelProvider, sink } = capturing();
    await mergeSkillsIntoUmbrella(
      [
        { name: "a", description: "Use when rotating sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa", body: "step one" },
        { name: "b", description: "Use when deploying", body: "run with sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb" }
      ],
      { model: "m", modelProvider }
    );
    const body = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(body).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(body).not.toContain("sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(body.match(/\[redacted-anthropic-key\]/gu)?.length).toBe(2);
  });

  it("sends temperature 0.3 / maxOutputTokens 400 by default and honours overrides", async () => {
    const def = capturing();
    await mergeSkillsIntoUmbrella(cluster, { model: "qwen3:8b", modelProvider: def.modelProvider });
    expect(def.sink.request?.temperature).toBe(0.3);
    expect(def.sink.request?.maxOutputTokens).toBe(400);
    expect(def.sink.request?.model).toBe("qwen3:8b");

    const ov = capturing();
    await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider: ov.modelProvider, temperature: 0, maxOutputTokens: 100 });
    expect(ov.sink.request?.temperature).toBe(0);
    expect(ov.sink.request?.maxOutputTokens).toBe(100);
  });

  it("honours a custom redact over the default", async () => {
    const { modelProvider, sink } = capturing();
    await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider, redact: (t) => `<<${t}>>` });
    const body = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(body).toContain("<<Use when summarising an email>>");
  });
});
