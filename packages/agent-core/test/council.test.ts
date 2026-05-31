import type { ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  buildCouncilPrompt,
  buildDebateQuestion,
  parseCouncilAnswer,
  produceCouncilReasoning,
  synthesizeCouncilAnswer,
  type CouncilModelOptions,
  type CouncilUtterance
} from "../src/council.js";

const fakeProvider = (output: string, sink?: { request?: ModelRequest }): Pick<CouncilModelOptions, "modelProvider">["modelProvider"] => ({
  generate: async (request: ModelRequest) => { if (sink) sink.request = request; return { id: "r", model: request.model, output }; }
});
const opts = (output: string, sink?: { request?: ModelRequest }): CouncilModelOptions => ({ model: "m", modelProvider: fakeProvider(output, sink) });

const utt = (peerId: string, reasoning: string): CouncilUtterance => ({ peerId, reasoning });

describe("parseCouncilAnswer — the grounding gate (Council can't invent a member)", () => {
  const valid = new Set(["alice", "bob"]);

  it("keeps only real contributor ids and trims the answer", () => {
    const out = parseCouncilAnswer('{"answer":"  go with plan A.  ","contributors":["alice","GHOST","bob"]}', valid);
    expect(out).toEqual({ answer: "go with plan A.", contributors: ["alice", "bob"] }); // GHOST dropped
  });

  it("dedupes contributors and treats a non-array contributors field as none", () => {
    expect(parseCouncilAnswer('{"answer":"x","contributors":["alice","alice"]}', valid)?.contributors).toEqual(["alice"]);
    expect(parseCouncilAnswer('{"answer":"x","contributors":"alice"}', valid)?.contributors).toEqual([]);
  });

  it("returns null for no JSON object, an empty/non-string answer, or invalid JSON", () => {
    expect(parseCouncilAnswer("no json here", valid)).toBeNull();
    expect(parseCouncilAnswer('{"answer":"   ","contributors":[]}', valid)).toBeNull();
    expect(parseCouncilAnswer('{"answer":42}', valid)).toBeNull();
    expect(parseCouncilAnswer("{bad json", valid)).toBeNull();
  });

  it("extracts the object even when wrapped in prose", () => {
    const out = parseCouncilAnswer('Here you go: {"answer":"do it","contributors":["bob"]} — done', valid);
    expect(out).toEqual({ answer: "do it", contributors: ["bob"] });
  });
});

describe("buildDebateQuestion / buildCouncilPrompt — pure renderers", () => {
  it("returns the question unchanged when no OTHER member spoke (excludes self + empties)", () => {
    expect(buildDebateQuestion("Q?", "me", [utt("me", "my take"), utt("x", "   ")])).toBe("Q?");
  });

  it("appends a whitespace-collapsed digest of the other members' reasoning + a refine instruction", () => {
    const q = buildDebateQuestion("Q?", "me", [utt("alice", "do  A\n\nbecause"), utt("me", "ignored")]);
    expect(q).toContain("[alice] do A because"); // collapsed, self excluded
    expect(q).toContain("Refine YOUR reasoning");
  });

  it("buildCouncilPrompt renders an [id] reasoning list under the question", () => {
    const prompt = buildCouncilPrompt("Q?", [utt("alice", "first"), utt("bob", "second")]);
    expect(prompt).toContain("Question: Q?");
    expect(prompt).toContain("[alice] first");
    expect(prompt).toContain("[bob] second");
  });
});

describe("produceCouncilReasoning — bounded, PII-redacted member utterance", () => {
  it("returns '' for an empty question without calling the model", async () => {
    let called = false;
    const out = await produceCouncilReasoning("   ", { model: "m", modelProvider: { generate: async () => { called = true; return { id: "r", model: "m", output: "x" }; } } });
    expect(out).toBe("");
    expect(called).toBe(false);
  });

  it("redacts the question into the prompt AND the model output before it crosses the swarm", async () => {
    const sink: { request?: ModelRequest } = {};
    const out = await produceCouncilReasoning("about sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa", opts("leak sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb here", sink));
    const userMsg = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).not.toContain("sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(out).toContain("[redacted-anthropic-key]");
  });

  it("fail-soft: a throwing provider yields ''", async () => {
    expect(await produceCouncilReasoning("Q?", { model: "m", modelProvider: { generate: async () => { throw new Error("down"); } } })).toBe("");
  });
});

describe("synthesizeCouncilAnswer — grounded final answer", () => {
  const members = [utt("alice", "plan A is safer"), utt("bob", "plan B is faster")];

  it("returns null with no usable utterances or an empty question", async () => {
    expect(await synthesizeCouncilAnswer("Q?", [], opts("{}"))).toBeNull();
    expect(await synthesizeCouncilAnswer("   ", members, opts("{}"))).toBeNull();
    expect(await synthesizeCouncilAnswer("Q?", [utt("", "x"), utt("a", "  ")], opts("{}"))).toBeNull(); // all filtered
  });

  it("grounds the answer against ONLY the usable member ids (drops an invented contributor)", async () => {
    const out = await synthesizeCouncilAnswer("Q?", members, opts('{"answer":"go A","contributors":["alice","INVENTED"]}'));
    expect(out).toEqual({ answer: "go A", contributors: ["alice"] });
  });

  it("fail-soft: a throwing provider yields null", async () => {
    expect(await synthesizeCouncilAnswer("Q?", members, { model: "m", modelProvider: { generate: async () => { throw new Error("down"); } } })).toBeNull();
  });
});
