import { describe, expect, it } from "vitest";

import { groundToolArguments } from "../src/tool-argument-grounding.js";

describe("groundToolArguments — drop a fabricated free-text arg the utterance doesn't support", () => {
  it("drops a location the user never mentioned", () => {
    const out = groundToolArguments({ location: "강남역", title: "회의" }, ["location", "notes"], "회의 잡아줘");
    expect(out.args).toEqual({ title: "회의" });
    expect(out.dropped).toEqual(["location"]);
  });

  it("keeps a location grounded across Korean particle attachment (강남역 ⊂ 강남역에서)", () => {
    const out = groundToolArguments({ location: "강남역", title: "회의" }, ["location"], "강남역에서 회의 잡아줘");
    expect(out.args).toEqual({ location: "강남역", title: "회의" });
    expect(out.dropped).toEqual([]);
  });

  it("keeps an English location the user stated", () => {
    const out = groundToolArguments({ location: "Room 4" }, ["location"], "book a meeting in Room 4");
    expect(out.dropped).toEqual([]);
  });

  it("does NOT ground a value token that is only a MID-word substring of an unrelated word", () => {
    // The old raw-substring matcher let a fabricated "art" survive on "start" (and "cat" on "catch").
    const out = groundToolArguments({ location: "art studio" }, ["location"], "let's start the meeting");
    expect(out.args).toEqual({});
    expect(out.dropped).toEqual(["location"]);
  });

  it("still grounds across morphology — a token that PREFIXES a longer utterance word (meeting → meetings)", () => {
    const out = groundToolArguments({ notes: "meeting agenda" }, ["notes"], "set up the meetings tomorrow");
    expect(out.dropped).toEqual([]); // "meeting" begins the word "meetings" — a word-start match, kept
  });

  it("drops fabricated notes but keeps grounded ones", () => {
    const out = groundToolArguments(
      { notes: "bring your passport", location: "공항" },
      ["location", "notes"],
      "공항 가는 일정 추가해줘"
    );
    expect(out.args).toEqual({ location: "공항" });
    expect(out.dropped).toEqual(["notes"]);
  });

  it("never touches a required/non-listed arg or a non-string value", () => {
    const out = groundToolArguments({ title: "fabricated title", count: 3 }, ["location"], "anything");
    expect(out.args).toEqual({ title: "fabricated title", count: 3 });
    expect(out.dropped).toEqual([]);
  });

  it("fail-open on an empty utterance — never drop when grounding can't be assessed", () => {
    const out = groundToolArguments({ location: "강남역" }, ["location"], "   ");
    expect(out.args).toEqual({ location: "강남역" });
    expect(out.dropped).toEqual([]);
  });

  it("drops fabricated tag elements but keeps grounded ones (string array)", () => {
    const out = groundToolArguments(
      { tags: ["운동", "회의", "강남"], title: "운동" },
      ["tags"],
      "운동 일정 추가해줘"
    );
    expect(out.args).toEqual({ tags: ["운동"], title: "운동" });
    expect(out.dropped).toEqual(["tags"]);
  });

  it("removes the tags arg entirely when every element is fabricated", () => {
    const out = groundToolArguments({ tags: ["회의", "강남"] }, ["tags"], "운동 추가");
    expect(out.args).toEqual({});
    expect(out.dropped).toEqual(["tags"]);
  });

  it("keeps a fully-grounded tag array untouched (not reported as dropped)", () => {
    const out = groundToolArguments({ tags: ["운동"] }, ["tags"], "운동 일정");
    expect(out.args).toEqual({ tags: ["운동"] });
    expect(out.dropped).toEqual([]);
  });

  it("does not mutate the input object", () => {
    const input = { location: "강남역", title: "회의" };
    groundToolArguments(input, ["location"], "회의");
    expect(input).toEqual({ location: "강남역", title: "회의" });
  });
});
