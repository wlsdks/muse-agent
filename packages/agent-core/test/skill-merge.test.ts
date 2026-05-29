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
});
