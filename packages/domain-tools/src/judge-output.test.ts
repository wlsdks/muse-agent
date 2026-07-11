import { describe, expect, it } from "vitest";

import { parseJudgeStringArray } from "./judge-output.js";

describe("parseJudgeStringArray", () => {
  it("extracts a bare JSON array of strings", () => {
    expect(parseJudgeStringArray("[\"a\", \"b\"]")).toEqual(["a", "b"]);
  });

  it("extracts the array when the model wraps it in prose before and after", () => {
    const raw = "Sure, here are the top matches:\n[\"one\", \"two\"]\nHope that helps!";
    expect(parseJudgeStringArray(raw)).toEqual(["one", "two"]);
  });

  it("takes only the first balanced top-level array when a nested array is present", () => {
    const raw = "[\"outer\", [\"nested\", \"ignored\"], \"tail\"]";
    expect(parseJudgeStringArray(raw)).toEqual(["outer", "tail"]);
  });

  it("returns an empty array when there is no array at all", () => {
    expect(parseJudgeStringArray("no brackets here")).toEqual([]);
  });

  it("returns an empty array on malformed JSON inside the brackets", () => {
    expect(parseJudgeStringArray("[\"a\", \"b\"")).toEqual([]);
    expect(parseJudgeStringArray("[\"a\", ,]")).toEqual([]);
  });

  it("filters out non-string elements mixed into the array", () => {
    const raw = "[\"keep\", 42, null, {\"id\": \"x\"}, true, \"also-keep\"]";
    expect(parseJudgeStringArray(raw)).toEqual(["keep", "also-keep"]);
  });

  it("filters out empty-string elements", () => {
    expect(parseJudgeStringArray("[\"a\", \"\", \"b\"]")).toEqual(["a", "b"]);
  });
});
