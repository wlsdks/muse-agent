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
});
