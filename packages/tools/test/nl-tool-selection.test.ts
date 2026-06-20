import { describe, expect, it } from "vitest";

import { parseNaturalLanguageToolSelection } from "../src/nl-tool-selection.js";

const TOOLS = ["time_now", "time_diff", "next_weekday_date", "web_search"];

describe("parseNaturalLanguageToolSelection (Natural Language Tools, arXiv 2510.14453)", () => {
  it("picks the single named tool from prose", () => {
    expect(parseNaturalLanguageToolSelection("I'd use the `time_now` tool to get the current time.", TOOLS).tool).toBe("time_now");
  });

  it("resolves a 'use A, not B' answer to A (earliest mention)", () => {
    expect(parseNaturalLanguageToolSelection("Use time_diff here, not time_now.", TOOLS).tool).toBe("time_diff");
  });

  it("returns no tool on an explicit no-tool answer", () => {
    expect(parseNaturalLanguageToolSelection("None — this is just a greeting.", TOOLS).tool).toBeUndefined();
    expect(parseNaturalLanguageToolSelection("no tool is needed", TOOLS).tool).toBeUndefined();
    expect(parseNaturalLanguageToolSelection("필요 없음", TOOLS).tool).toBeUndefined();
  });

  it("does not match a tool name embedded inside another identifier", () => {
    expect(parseNaturalLanguageToolSelection("use my_time_now_helper", TOOLS).tool).toBeUndefined();
  });

  it("returns no tool when none is named and no explicit decline", () => {
    expect(parseNaturalLanguageToolSelection("I will just answer directly.", TOOLS).tool).toBeUndefined();
  });

  it("handles empty / non-string output", () => {
    expect(parseNaturalLanguageToolSelection("", TOOLS).tool).toBeUndefined();
    expect(parseNaturalLanguageToolSelection("   ", TOOLS).tool).toBeUndefined();
  });

  it("a named tool wins even if 'none of the others' appears later", () => {
    expect(parseNaturalLanguageToolSelection("Pick next_weekday_date; none of the others fit.", TOOLS).tool).toBe("next_weekday_date");
  });

  it("skips a NEGATION-LED tool mention and picks the chosen tool after it (reasoning-action alignment, MAST arXiv 2503.13657)", () => {
    expect(parseNaturalLanguageToolSelection("Do not use time_now; use time_diff instead.", TOOLS).tool).toBe("time_diff");
    expect(parseNaturalLanguageToolSelection("Don't use time_now. I'd call time_diff.", TOOLS).tool).toBe("time_diff");
    expect(parseNaturalLanguageToolSelection("Not time_now — time_diff is the right one.", TOOLS).tool).toBe("time_diff");
    expect(parseNaturalLanguageToolSelection("time_now은 쓰지 말고 time_diff를 써.", TOOLS).tool).toBe("time_diff");
  });

  it("a single negated tool with no alternative resolves to no tool, not the rejected one", () => {
    expect(parseNaturalLanguageToolSelection("Don't use time_now for this.", TOOLS).tool).toBeUndefined();
    expect(parseNaturalLanguageToolSelection("Not web_search — just answer directly.", TOOLS).tool).toBeUndefined();
    expect(parseNaturalLanguageToolSelection("time_now은 쓰지 마.", TOOLS).tool).toBeUndefined();
  });

  it("does NOT treat a plain affirmative or a trailing 'not B' as a leading negation (no over-skip)", () => {
    expect(parseNaturalLanguageToolSelection("I'd use the `time_now` tool to get the current time.", TOOLS).tool).toBe("time_now");
    expect(parseNaturalLanguageToolSelection("Use time_diff here, not time_now.", TOOLS).tool).toBe("time_diff");
    expect(parseNaturalLanguageToolSelection("Cannot answer without time_now data.", TOOLS).tool).toBe("time_now");
  });
});
