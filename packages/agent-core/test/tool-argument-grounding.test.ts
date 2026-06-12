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

  it("drops fabricated tag elements but keeps grounded ones — partial array NOT reported as dropped", () => {
    const out = groundToolArguments(
      { tags: ["운동", "회의", "강남"], title: "운동" },
      ["tags"],
      "운동 일정 추가해줘"
    );
    expect(out.args).toEqual({ tags: ["운동"], title: "운동" });
    // partial clean: the arg survives with the grounded element, so it is NOT in dropped
    expect(out.dropped).toEqual([]);
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

  it("partial array: cleaned survivors kept, name absent from dropped", () => {
    const out = groundToolArguments(
      { tags: ["work", "fabricated"] },
      ["tags"],
      "tag it work and urgent"
    );
    expect(out.args).toEqual({ tags: ["work"] });
    expect(out.dropped).not.toContain("tags");
  });

  it("all-fabricated array: arg removed AND reported in dropped", () => {
    const out = groundToolArguments(
      { tags: ["xyz", "qwe"] },
      ["tags"],
      "add a task for today"
    );
    expect(Object.prototype.hasOwnProperty.call(out.args, "tags")).toBe(false);
    expect(out.dropped).toContain("tags");
  });

  it("all-grounded array: unchanged and not in dropped", () => {
    const out = groundToolArguments(
      { tags: ["work", "urgent"] },
      ["tags"],
      "tag it work and urgent"
    );
    expect(out.args).toEqual({ tags: ["work", "urgent"] });
    expect(out.dropped).toEqual([]);
  });

  it("string full drop still reported in dropped (regression)", () => {
    const out = groundToolArguments(
      { notes: "completely fabricated content" },
      ["notes"],
      "add a task"
    );
    expect(Object.prototype.hasOwnProperty.call(out.args, "notes")).toBe(false);
    expect(out.dropped).toContain("notes");
  });

  it("string grounded kept and not in dropped (regression)", () => {
    const out = groundToolArguments(
      { notes: "urgent task" },
      ["notes"],
      "add an urgent task"
    );
    expect(out.args).toEqual({ notes: "urgent task" });
    expect(out.dropped).toEqual([]);
  });

  it("does not mutate the input object", () => {
    const input = { location: "강남역", title: "회의" };
    groundToolArguments(input, ["location"], "회의");
    expect(input).toEqual({ location: "강남역", title: "회의" });
  });

  it("drops a fabricated followup-cancel reason the user never stated", () => {
    // The 8B fabricates a reason like "user changed plans" when the user
    // merely said "cancel that followup". The reason must be dropped.
    const out = groundToolArguments(
      { id: "fu_123", reason: "user changed plans" },
      ["reason"],
      "cancel that followup"
    );
    expect(out.args).toEqual({ id: "fu_123" });
    expect(out.dropped).toEqual(["reason"]);
  });

  it("keeps a followup-cancel reason the user explicitly stated", () => {
    const out = groundToolArguments(
      { id: "fu_123", reason: "rescheduled" },
      ["reason"],
      "cancel the followup — rescheduled"
    );
    expect(out.args).toEqual({ id: "fu_123", reason: "rescheduled" });
    expect(out.dropped).toEqual([]);
  });
});
