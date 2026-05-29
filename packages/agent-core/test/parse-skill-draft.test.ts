import { describe, expect, it } from "vitest";

import { parseSkillDraft } from "../src/skill-review.js";

describe("parseSkillDraft", () => {
  it("returns null for empty / whitespace-only input", () => {
    expect(parseSkillDraft("")).toBeNull();
    expect(parseSkillDraft("   \n  \t")).toBeNull();
  });

  it("returns null when the draft opens with the NONE sentinel", () => {
    expect(parseSkillDraft("NONE")).toBeNull();
    expect(parseSkillDraft("NONE found worth saving")).toBeNull();
  });

  it("parses the name / description / body triple", () => {
    expect(parseSkillDraft("name: Greet\ndescription: Say hi\nbody: Always greet warmly.")).toEqual({
      name: "Greet",
      description: "Say hi",
      body: "Always greet warmly.",
    });
  });

  it("is case-insensitive on the field labels and tolerates CRLF line endings", () => {
    expect(parseSkillDraft("NAME: Greet\r\nDescription: Hi\r\nBODY: do it")).toEqual({
      name: "Greet",
      description: "Hi",
      body: "do it",
    });
  });

  it("captures a multi-line body that starts on the next line", () => {
    expect(parseSkillDraft("name: A\ndescription: B\nbody:\nline1\nline2")).toEqual({
      name: "A",
      description: "B",
      body: "line1\nline2",
    });
  });

  it("finds the fields even when surrounded by prose", () => {
    expect(parseSkillDraft("Here is a skill:\nname: A\ndescription: B\nbody: C\nthanks!")).toEqual({
      name: "A",
      description: "B",
      body: "C\nthanks!",
    });
  });

  it("returns null when any required field is absent", () => {
    expect(parseSkillDraft("name: A\ndescription: B")).toBeNull(); // no body
    expect(parseSkillDraft("description: B\nbody: C")).toBeNull(); // no name
    expect(parseSkillDraft("name: A\nbody: C")).toBeNull(); // no description
  });

  it("treats a blank field value as missing instead of swallowing the next line", () => {
    // A blank `name:` value must NOT absorb the following `description:`
    // line as the name — that yields a silently mislabeled draft. Reject.
    expect(parseSkillDraft("name:   \ndescription: B\nbody: C")).toBeNull();
    expect(parseSkillDraft("name: A\ndescription:\nbody: C")).toBeNull();
  });
});
