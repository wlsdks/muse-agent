import { describe, expect, it } from "vitest";

import { deltaMergePlaybookStrategies } from "./playbook-merge.js";
import { lexicalTokens } from "./knowledge-recall.js";

describe("deltaMergePlaybookStrategies (ACE: deterministic delta ops, no LLM rewrite)", () => {
  it("collapses exact and whitespace-variant duplicates without a model", () => {
    const merged = deltaMergePlaybookStrategies([
      "회의 전에 안건을 정리한다",
      "회의 전에  안건을 정리한다 ",
      "회의 전에 안건을 정리한다"
    ]);
    expect(merged).toBe("회의 전에 안건을 정리한다");
  });

  it("subsumption: keeps the MORE SPECIFIC strategy when one token-covers the other", () => {
    const merged = deltaMergePlaybookStrategies([
      "회의 전에 안건을 정리한다",
      "회의 전에 안건을 정리하고 참석자에게 미리 공유한다"
    ]);
    expect(merged).toBe("회의 전에 안건을 정리하고 참석자에게 미리 공유한다");
  });

  it("returns undefined for genuinely distinct strategies — never force-compresses (anti brevity-bias)", () => {
    expect(deltaMergePlaybookStrategies([
      "답변은 두 문장 이내로 짧게",
      "일정 등록 전에 항상 시간대를 확인"
    ])).toBeUndefined();
  });

  it("anti-collapse invariant: a produced merge token-covers EVERY input", () => {
    const inputs = [
      "보고서는 표로 정리해 달라",
      "보고서는 표로 정리해 달라, 숫자는 천 단위 콤마"
    ];
    const merged = deltaMergePlaybookStrategies(inputs);
    expect(merged).toBeDefined();
    const mergedTokens = lexicalTokens(merged ?? "");
    for (const input of inputs) {
      for (const token of lexicalTokens(input)) {
        expect(mergedTokens.has(token)).toBe(true);
      }
    }
  });

  it("fewer than two texts → undefined", () => {
    expect(deltaMergePlaybookStrategies([])).toBeUndefined();
    expect(deltaMergePlaybookStrategies(["하나뿐"])).toBeUndefined();
  });
});
