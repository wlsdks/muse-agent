import { describe, expect, it } from "vitest";

import { createGreetingStripResponseFilter } from "../src/response-filters.js";
import type { ResponseFilterContext } from "../src/types.js";

const baseResponse = (output: string) => ({ id: "r-1", model: "diagnostic/smoke", output });

const baseContext: ResponseFilterContext = {
  input: { messages: [{ content: "any", role: "user" }], model: "diagnostic/smoke" },
  response: { id: "r-1", model: "diagnostic/smoke", output: "" },
  runId: "run-1",
  toolsUsed: []
};

describe("createGreetingStripResponseFilter", () => {
  const filter = createGreetingStripResponseFilter();

  it("strips a leading Korean greeting", async () => {
    const result = await filter.apply(baseResponse("안녕하세요! 답은 42입니다."), baseContext);
    expect(result.output).toBe("답은 42입니다.");
  });

  it("strips a follow-up greeting", async () => {
    const result = await filter.apply(baseResponse("반갑습니다! 내용입니다."), baseContext);
    expect(result.output).toBe("내용입니다.");
  });

  it("strips a leading compliance filler (물론이죠! / 알겠습니다. / 네! / 당연하죠! / 그럼요!)", async () => {
    for (const [input, expected] of [
      ["물론이죠! 파리입니다.", "파리입니다."],
      ["알겠습니다. 작업을 추가했습니다.", "작업을 추가했습니다."],
      ["네! 내일은 화요일입니다.", "내일은 화요일입니다."],
      ["당연하죠! 가능합니다.", "가능합니다."],
      ["그럼요! 처리했어요.", "처리했어요."],
      ["물론입니다. 답은 42입니다.", "답은 42입니다."]
    ] as const) {
      const result = await filter.apply(baseResponse(input), baseContext);
      expect(result.output).toBe(expected);
    }
  });

  it("strips filler then greeting in the same chain", async () => {
    const result = await filter.apply(baseResponse("물론이죠! 안녕하세요! 파리입니다."), baseContext);
    expect(result.output).toBe("파리입니다.");
  });

  it("does NOT strip real content that merely starts with a filler word", async () => {
    for (const input of [
      "물론 그것도 가능합니다.",
      "당연히 맞는 말씀입니다.",
      "네." // a one-word reply must never be nuked to empty
    ]) {
      const result = await filter.apply(baseResponse(input), baseContext);
      expect(result.output).toBe(input);
    }
  });

  it("returns the response unchanged when no greeting or filler is present", async () => {
    const original = baseResponse("답만 말합니다. 군더더기 없음.");
    const result = await filter.apply(original, baseContext);
    expect(result.output).toBe(original.output);
  });
});
