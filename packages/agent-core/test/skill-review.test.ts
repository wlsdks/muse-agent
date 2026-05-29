import { describe, expect, it } from "vitest";

import { detectSkillCandidates, draftSkillFromSignal, reviewSkillsFromTurns, type SkillReviewSignal } from "../src/skill-review.js";
import type { SessionTurnLine } from "../src/episodic-summariser.js";

const turn = (role: "user" | "assistant", content: string): SessionTurnLine => ({ content, role });

describe("detectSkillCandidates", () => {
  it("emits a correction signal when the user corrected the assistant", () => {
    const turns = [
      turn("user", "summarise this"),
      turn("assistant", "Here is a prose summary..."),
      turn("user", "no, that's wrong — always give me bullet points")
    ];
    const signals = detectSkillCandidates(turns);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe("correction");
  });

  it("returns nothing when there is no correction", () => {
    const turns = [turn("user", "hi"), turn("assistant", "hello")];
    expect(detectSkillCandidates(turns)).toHaveLength(0);
  });

  it("caps the number of candidates", () => {
    const turns: SessionTurnLine[] = [];
    for (let i = 0; i < 5; i += 1) {
      turns.push(turn("user", `ask ${i.toString()}`), turn("assistant", "ans"), turn("user", "no, that's not what i asked"));
    }
    expect(detectSkillCandidates(turns, { maxCandidates: 2 })).toHaveLength(2);
  });
});

function fakeProvider(output: string): { generate: () => Promise<{ output: string }>; calls: number } {
  const p = {
    calls: 0,
    generate: async (): Promise<{ output: string }> => {
      p.calls += 1;
      return { output };
    }
  };
  return p;
}

const correctionSignal: SkillReviewSignal = {
  exchange: {
    correction: "no — when exporting, always convert to PDF first then attach",
    priorAnswer: "I attached the .docx.",
    request: "send the report to my manager"
  },
  kind: "correction"
};

describe("draftSkillFromSignal", () => {
  it("parses a procedural draft", async () => {
    const provider = fakeProvider(
      "name: export-then-attach\ndescription: Use when sending a document; convert to PDF before attaching.\nbody:\n1. Convert to PDF.\n2. Attach the PDF."
    );
    const draft = await draftSkillFromSignal(correctionSignal, { model: "qwen", modelProvider: provider as never });
    expect(draft).not.toBeNull();
    expect(draft!.name).toBe("export-then-attach");
    expect(draft!.body).toContain("Convert to PDF");
  });

  it("returns null when the model says NONE (preference, not a procedure)", async () => {
    const provider = fakeProvider("NONE");
    expect(await draftSkillFromSignal(correctionSignal, { model: "qwen", modelProvider: provider as never })).toBeNull();
  });

  it("returns null on malformed output", async () => {
    const provider = fakeProvider("garbage with no fields");
    expect(await draftSkillFromSignal(correctionSignal, { model: "qwen", modelProvider: provider as never })).toBeNull();
  });

  it("returns null when generate throws (fail-soft)", async () => {
    const provider = {
      generate: async (): Promise<{ output: string }> => {
        throw new Error("model down");
      }
    };
    expect(await draftSkillFromSignal(correctionSignal, { model: "qwen", modelProvider: provider as never })).toBeNull();
  });
});

describe("reviewSkillsFromTurns — detect → draft → write (engine skill arm)", () => {
  const hardTurns: SessionTurnLine[] = [
    turn("user", "send the report to my manager"),
    turn("assistant", "I attached the .docx."),
    turn("user", "no, that's not what I asked — always export to PDF first, then attach")
  ];
  const SKILL = "name: export-then-attach\ndescription: Use when sending a document\nbody:\n1. export to PDF\n2. attach the PDF";

  it("authors a skill when a procedural correction drafts one and the writer creates it", async () => {
    const written: string[] = [];
    const result = await reviewSkillsFromTurns(hardTurns, {
      model: "qwen",
      modelProvider: fakeProvider(SKILL) as never,
      writeDraft: async (draft) => { written.push(draft.name); return { action: "create", name: draft.name }; }
    });
    expect(result.authored).toEqual(["export-then-attach (create)"]);
    expect(written).toEqual(["export-then-attach"]);
  });

  it("authors nothing on a NONE draft and on a quarantined/skip write", async () => {
    const none = await reviewSkillsFromTurns(hardTurns, { model: "q", modelProvider: fakeProvider("NONE") as never, writeDraft: async () => ({ action: "create", name: "x" }) });
    expect(none.authored).toEqual([]);
    const quarantined = await reviewSkillsFromTurns(hardTurns, { model: "q", modelProvider: fakeProvider(SKILL) as never, writeDraft: async () => ({ action: "quarantined", name: "export-then-attach" }) });
    expect(quarantined.authored).toEqual([]); // quarantine is not active → not authored
  });

  it("authors nothing when there is no correction (trivial turn)", async () => {
    const result = await reviewSkillsFromTurns([turn("user", "hi"), turn("assistant", "hello")], {
      model: "q", modelProvider: fakeProvider(SKILL) as never, writeDraft: async () => ({ action: "create", name: "x" })
    });
    expect(result.authored).toEqual([]);
  });
});
