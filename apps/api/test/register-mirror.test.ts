import { describe, expect, it } from "vitest";

import { formalityInstructionLine } from "../src/register-mirror.js";

describe("formalityInstructionLine", () => {
  it("존댓말: returns a line naming 존댓말 for a polite-ending turn", () => {
    for (const text of ["오늘 일정 알려주세요", "확인했습니다", "이거 맛있어요", "그거 좋아요"]) {
      const line = formalityInstructionLine(text);
      expect(line, text).toBeDefined();
      expect(line, text).toContain("존댓말");
    }
  });

  it("반말: returns a line naming 반말 for a casual-ending turn", () => {
    for (const text of ["오늘 일정 알려줘", "확인했어", "이거 맛있어", "그거 좋아"]) {
      const line = formalityInstructionLine(text);
      expect(line, text).toBeDefined();
      expect(line, text).toContain("반말");
    }
  });

  it("undefined: no Hangul at all (English)", () => {
    expect(formalityInstructionLine("what's on my calendar tomorrow?")).toBeUndefined();
  });

  it("undefined: Hangul with no ending/vocative register signal (a bare noun)", () => {
    expect(formalityInstructionLine("점심")).toBeUndefined();
  });

  it("undefined: empty text", () => {
    expect(formalityInstructionLine("")).toBeUndefined();
  });
});
