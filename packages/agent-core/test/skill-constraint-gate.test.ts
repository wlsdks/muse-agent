import { type ModelProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  draftSkillFromSignal,
  parseConstrainedSkillDraft,
  type SkillDraft,
  type SkillReviewSignal,
  skillDraftConstraintViolations,
} from "../src/index.js";
import { mergeSkillsIntoUmbrella } from "../src/skill-merge.js";

const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({ body: "do the thing", description: "a useful skill", name: "my-skill", ...over });

function stubProvider(output: string): ModelProvider {
  return { async generate() { return { id: "r", model: "m", output }; }, id: "stub", async listModels() { return []; }, async *stream() {} };
}
const signal: SkillReviewSignal = { exchange: { correction: "do it this way", priorAnswer: "wrong answer" }, kind: "correction" };

describe("skillDraftConstraintViolations — hermes-style gate (body <=15KB, desc <=500, name <=80)", () => {
  it("passes a within-limit draft", () => {
    expect(skillDraftConstraintViolations(draft())).toEqual([]);
  });

  it("flags an over-size body, at the byte boundary", () => {
    expect(skillDraftConstraintViolations(draft({ body: "x".repeat(15 * 1024) }))).toEqual([]);
    expect(skillDraftConstraintViolations(draft({ body: "x".repeat(15 * 1024 + 1) }))).toHaveLength(1);
  });

  it("counts multi-byte (UTF-8) body bytes, not characters", () => {
    // each '가' is 3 bytes; 5121 of them = 15363 B > 15360 limit
    expect(skillDraftConstraintViolations(draft({ body: "가".repeat(5121) }))).toHaveLength(1);
    // 5000 of them = 15000 B, under the limit
    expect(skillDraftConstraintViolations(draft({ body: "가".repeat(5000) }))).toEqual([]);
  });

  it("flags an over-long description at the char boundary", () => {
    expect(skillDraftConstraintViolations(draft({ description: "y".repeat(500) }))).toEqual([]);
    expect(skillDraftConstraintViolations(draft({ description: "y".repeat(501) }))).toHaveLength(1);
  });

  it("flags an over-long name", () => {
    expect(skillDraftConstraintViolations(draft({ name: "n".repeat(80) }))).toEqual([]);
    expect(skillDraftConstraintViolations(draft({ name: "n".repeat(81) }))).toHaveLength(1);
  });

  it("reports every violation at once", () => {
    expect(skillDraftConstraintViolations(draft({ body: "x".repeat(20 * 1024), description: "y".repeat(600), name: "n".repeat(90) }))).toHaveLength(3);
  });
});

describe("parseConstrainedSkillDraft", () => {
  it("returns null for an unparseable draft", () => {
    expect(parseConstrainedSkillDraft("NONE")).toBeNull();
    expect(parseConstrainedSkillDraft("name: x")).toBeNull(); // missing description/body
  });

  it("returns the draft when parseable AND within constraints", () => {
    expect(parseConstrainedSkillDraft("name: s\ndescription: ok\nbody: hi")).toEqual({ body: "hi", description: "ok", name: "s" });
  });

  it("returns null when parseable but over a constraint", () => {
    expect(parseConstrainedSkillDraft(`name: s\ndescription: ${"y".repeat(501)}\nbody: hi`)).toBeNull();
  });
});

describe("the authoring producers reject an over-limit drafted skill (not loadable)", () => {
  it("draftSkillFromSignal returns null for an over-size body, a draft for a within-limit one", async () => {
    const oversized = `name: s\ndescription: ok\nbody: ${"z".repeat(16 * 1024)}`;
    expect(await draftSkillFromSignal(signal, { model: "m", modelProvider: stubProvider(oversized) })).toBeNull();
    expect((await draftSkillFromSignal(signal, { model: "m", modelProvider: stubProvider("name: s\ndescription: ok\nbody: hi") }))?.name).toBe("s");
  });

  it("mergeSkillsIntoUmbrella returns undefined for an over-limit umbrella draft", async () => {
    const cluster: SkillDraft[] = [draft({ name: "a" }), draft({ name: "b" })];
    const oversized = `name: umbrella\ndescription: ${"y".repeat(600)}\nbody: merged`;
    expect(await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider: stubProvider(oversized) })).toBeUndefined();
    expect((await mergeSkillsIntoUmbrella(cluster, { model: "m", modelProvider: stubProvider("name: umbrella\ndescription: ok\nbody: merged") }))?.name).toBe("umbrella");
  });
});
