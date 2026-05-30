import { describe, expect, it } from "vitest";

import { createCasualLureStripResponseFilter } from "../src/response-filters.js";
import type { ResponseFilterContext } from "../src/types.js";

// The Korean casual-lure strip filter is Muse's PRIMARY-language guard against
// padding a clean answer with an eager "무엇을 도와드릴까요?" / "혹시 더
// 필요하시면…" closing — the trait that keeps the assistant from over-engaging.
// Its English counterpart is covered in english-locale-filters.test.ts, but the
// Korean rule table + the work-tool / length / drop-cap guards had only
// incidental integration coverage. Pin them directly. All known-answer (no LLM).

const response = (output: string) => ({ id: "r-1", model: "diagnostic/smoke", output });
const context = (toolsUsed: string[] = []): ResponseFilterContext => ({
  input: { messages: [{ content: "any", role: "user" }], model: "diagnostic/smoke" },
  response: { id: "r-1", model: "diagnostic/smoke", output: "" },
  runId: "run-1",
  toolsUsed
});

describe("createCasualLureStripResponseFilter (Korean)", () => {
  const filter = createCasualLureStripResponseFilter();

  it("strips a trailing '무엇을 도와드릴까요?' lure off a short no-tools answer", async () => {
    const out = await filter.apply(response("서울 날씨는 맑습니다. 무엇을 도와드릴까요?"), context());
    expect(out.output).toBe("서울 날씨는 맑습니다.");
  });

  it("strips a '혹시 더 필요하시면 말씀해 주세요!' closing pleasantry", async () => {
    const out = await filter.apply(response("내일 일정은 3시 회의입니다. 혹시 더 필요하시면 말씀해 주세요!"), context());
    expect(out.output).toBe("내일 일정은 3시 회의입니다.");
  });

  it("leaves a clean answer with no lure untouched", async () => {
    const out = await filter.apply(response("답은 42입니다."), context());
    expect(out.output).toBe("답은 42입니다.");
  });

  it("does NOT strip when a WORK tool ran — a real action's closing line isn't a lure", async () => {
    const text = "서울 날씨는 맑습니다. 무엇을 도와드릴까요?";
    const out = await filter.apply(response(text), context(["web_search"]));
    expect(out.output).toBe(text);
  });

  it("still strips when only a reaction-only tool (add_reaction) ran — that isn't real work", async () => {
    const out = await filter.apply(response("오늘 기온은 18도입니다. 더 궁금한 점 있으세요?"), context(["add_reaction"]));
    expect(out.output).toBe("오늘 기온은 18도입니다.");
  });

  it("does NOT strip a long (>500 char) substantive answer that merely ends in a lure", async () => {
    const long = `${"가".repeat(520)} 무엇을 도와드릴까요?`;
    const out = await filter.apply(response(long), context());
    expect(out.output).toBe(long);
  });

  it("drops at most 3 trailing lure sentences (the drop-count cap)", async () => {
    // Four stacked lures; the cap keeps the 4th-from-end, so a runaway strip
    // can never eat into the real answer beyond three closings.
    const four = "핵심 답입니다. 더 궁금한 점 있으세요? 언제든 불러주세요! 무엇을 도와드릴까요? 말씀해 주세요!";
    const out = await filter.apply(response(four), context());
    expect(out.output).toBe("핵심 답입니다. 더 궁금한 점 있으세요?");
  });

  it("returns the response unchanged (not blank) for whitespace-only output", async () => {
    const out = await filter.apply(response("   "), context());
    expect(out.output).toBe("   ");
  });
});
