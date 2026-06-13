import { describe, expect, it, vi } from "vitest";

import {
  synthesizeReflections,
  verifyReflectionsGrounding,
  type Reflection,
  type ReflectionInput
} from "../src/reflection-synthesis.js";

const reflection = (insight: string, ...sourceIds: string[]): Reflection => ({
  insight,
  sourceIds,
  supportCount: sourceIds.length
});

const sources = new Map<string, string>([
  ["ep-1", "Left work at 4pm to make the kids' recital."],
  ["ep-2", "Declined the Saturday on-call shift to keep the weekend free."]
]);

describe("verifyReflectionsGrounding — RGV re-verification applied to the reflection surface", () => {
  it("keeps a reflection the injected judge upholds", async () => {
    const out = await verifyReflectionsGrounding([reflection("Values protecting family time", "ep-1", "ep-2")], sources, async () => true);
    expect(out.map((r) => r.insight)).toEqual(["Values protecting family time"]);
  });

  it("drops a reflection the judge rejects (a confabulated insight that cites real-but-unrelated sources)", async () => {
    const out = await verifyReflectionsGrounding([reflection("Is training for a marathon", "ep-1", "ep-2")], sources, async () => false);
    expect(out).toEqual([]);
  });

  it("fail-closes — a judge error drops the reflection (a dream never survives an unverifiable check)", async () => {
    const out = await verifyReflectionsGrounding([reflection("Values family time", "ep-1", "ep-2")], sources, async () => {
      throw new Error("model unreachable");
    });
    expect(out).toEqual([]);
  });

  it("fail-closes WITHOUT consulting the judge when no cited source resolves (empty evidence is unverifiable)", async () => {
    const judge = vi.fn(async () => true);
    const out = await verifyReflectionsGrounding([reflection("An insight citing a vanished source", "missing-id")], sources, judge);
    expect(out).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });

  it("with k samples (reverifySamples=2), one NO among the verdicts drops the reflection (a flaky YES can't promote a dream)", async () => {
    const judge = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const out = await verifyReflectionsGrounding([reflection("Values family time", "ep-1", "ep-2")], sources, judge, 2);
    expect(out).toEqual([]);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("with k samples, an all-YES run keeps the reflection and consults the judge exactly k times", async () => {
    const judge = vi.fn(async () => true);
    const out = await verifyReflectionsGrounding([reflection("Values family time", "ep-1", "ep-2")], sources, judge, 3);
    expect(out.map((r) => r.insight)).toEqual(["Values family time"]);
    expect(judge).toHaveBeenCalledTimes(3);
  });

  it("assembles the evidence the judge sees from the cited source TEXTS, not the ids", async () => {
    let seen = "";
    await verifyReflectionsGrounding([reflection("Protects weekends", "ep-2")], sources, async ({ evidence }) => {
      seen = evidence;
      return true;
    });
    expect(seen).toContain("Declined the Saturday on-call shift");
    expect(seen).not.toContain("ep-2");
  });
});

const two: readonly ReflectionInput[] = [
  { id: "a", text: "Left work at 4pm for the recital." },
  { id: "b", text: "Skipped the Saturday shift to keep the weekend." }
];

const fakeProvider = (output: string) => ({ generate: async () => ({ output }) });

describe("synthesizeReflections — optional grounding re-verification", () => {
  it("filters synthesised reflections through an injected judge when one is provided", async () => {
    const provider = fakeProvider(JSON.stringify([{ insight: "Guards personal time", sources: ["a", "b"] }]));
    const kept = await synthesizeReflections(two, { model: "m", modelProvider: provider, reverify: async () => true });
    expect(kept.map((r) => r.insight)).toEqual(["Guards personal time"]);
    const dropped = await synthesizeReflections(two, { model: "m", modelProvider: provider, reverify: async () => false });
    expect(dropped).toEqual([]);
  });

  it("without a judge, behaves exactly as before (no re-verification)", async () => {
    const provider = fakeProvider(JSON.stringify([{ insight: "Guards personal time", sources: ["a", "b"] }]));
    const out = await synthesizeReflections(two, { model: "m", modelProvider: provider });
    expect(out.map((r) => r.insight)).toEqual(["Guards personal time"]);
  });
});
