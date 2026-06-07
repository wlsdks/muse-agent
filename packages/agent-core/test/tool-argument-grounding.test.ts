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

  it("does not mutate the input object", () => {
    const input = { location: "강남역", title: "회의" };
    groundToolArguments(input, ["location"], "회의");
    expect(input).toEqual({ location: "강남역", title: "회의" });
  });
});
