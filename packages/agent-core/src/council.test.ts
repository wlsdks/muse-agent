import { describe, expect, it } from "vitest";

import {
  buildCouncilPrompt,
  buildDebateQuestion,
  parseCouncilAnswer,
  produceCouncilReasoning,
  synthesizeCouncilAnswer,
  type CouncilUtterance
} from "./council.js";

describe("buildDebateQuestion — Multiagent Debate round-2 prompt", () => {
  const utterances: CouncilUtterance[] = [
    { peerId: "phone", reasoning: "buy if long term" },
    { peerId: "laptop", reasoning: "rent for flexibility" }
  ];
  it("appends the OTHER members' reasoning (not the member's own) and asks to refine", () => {
    const q = buildDebateQuestion("rent or buy?", "phone", utterances);
    expect(q).toContain("rent or buy?");
    expect(q).toContain("[laptop] rent for flexibility");
    expect(q).not.toContain("[phone]"); // its own round-1 isn't fed back to it
    expect(q).toMatch(/Refine YOUR reasoning/);
  });
  it("returns the question unchanged when no other members spoke", () => {
    expect(buildDebateQuestion("q", "phone", [{ peerId: "phone", reasoning: "x" }])).toBe("q");
    expect(buildDebateQuestion("q", "solo", [])).toBe("q");
  });
});

const peers = new Set(["phone", "laptop", "server"]);

describe("buildCouncilPrompt", () => {
  it("labels each member's reasoning with its [id]", () => {
    const p = buildCouncilPrompt("rent or buy?", [{ peerId: "phone", reasoning: "buy\n\n if long\tterm" }]);
    expect(p).toContain("Question: rent or buy?");
    expect(p).toContain("[phone] buy if long term");
  });
});

describe("parseCouncilAnswer — grounded synthesis (honesty guard)", () => {
  it("keeps only real contributor ids", () => {
    const a = parseCouncilAnswer('{"answer":"Buy if you will stay >5 years.","contributors":["phone","laptop","ghost"]}', peers);
    expect(a).toMatchObject({ answer: "Buy if you will stay >5 years." });
    expect(a!.contributors).toEqual(["phone", "laptop"]); // ghost dropped
  });

  it("tolerates prose around the JSON object and dedupes contributors", () => {
    const a = parseCouncilAnswer('here:\n{"answer":"X","contributors":["phone","phone","server"]}\nthanks', peers);
    expect(a!.contributors).toEqual(["phone", "server"]);
  });

  it("returns null on no JSON / empty answer / non-object", () => {
    expect(parseCouncilAnswer("I think you should buy.", peers)).toBeNull();
    expect(parseCouncilAnswer('{"answer":"   ","contributors":["phone"]}', peers)).toBeNull();
    expect(parseCouncilAnswer('["phone"]', peers)).toBeNull();
  });

  it("an answer with no real contributors still parses (contributors empty)", () => {
    expect(parseCouncilAnswer('{"answer":"Buy.","contributors":["nobody"]}', peers)).toMatchObject({ answer: "Buy.", contributors: [] });
  });
});

describe("synthesizeCouncilAnswer — model-driven", () => {
  const utterances: CouncilUtterance[] = [
    { peerId: "phone", reasoning: "Buying builds equity if you stay long term." },
    { peerId: "laptop", reasoning: "Renting keeps you flexible and avoids maintenance cost." }
  ];

  it("returns null without calling the model when there are no usable utterances / empty question", async () => {
    let called = false;
    const provider = { generate: async () => { called = true; return { output: "{}" }; } } as never;
    expect(await synthesizeCouncilAnswer("", utterances, { model: "m", modelProvider: provider })).toBeNull();
    expect(await synthesizeCouncilAnswer("q", [], { model: "m", modelProvider: provider })).toBeNull();
    expect(called).toBe(false);
  });

  it("grounds the synthesis (strips an invented contributor)", async () => {
    const provider = { generate: async () => ({ output: '{"answer":"Buy if long-term, else rent.","contributors":["phone","laptop","oracle"]}' }) } as never;
    const a = await synthesizeCouncilAnswer("rent or buy?", utterances, { model: "m", modelProvider: provider });
    expect(a!.contributors).toEqual(["phone", "laptop"]); // oracle invented → stripped
  });
});

describe("produceCouncilReasoning — bounded participant step", () => {
  it("redacts the reasoning before it leaves; empty question → ''", async () => {
    const provider = { generate: async () => ({ output: "Reason about it. key=sk-proj-AbCdEf0123456789GhIjKl0123456789" }) } as never;
    const out = await produceCouncilReasoning("should I switch jobs?", { model: "m", modelProvider: provider });
    expect(out).toContain("Reason about it");
    expect(out).not.toContain("sk-proj-AbCdEf0123456789GhIjKl0123456789"); // redacted
    expect(await produceCouncilReasoning("  ", { model: "m", modelProvider: provider })).toBe("");
  });
});
