import { describe, expect, it } from "vitest";

import { detectSkillCandidates } from "../src/skill-review.js";
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
