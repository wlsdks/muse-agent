import { describe, expect, it } from "vitest";

import { recoverToolArgsJson } from "../src/index.js";

describe("recoverToolArgsJson — repair the malformations a small local model emits (vs openclaw tool-call-repair, MIT)", () => {
  it.each([
    ["trailing comma", '{"city":"Seoul",}'],
    ["single-quoted object", "{'city':'Seoul'}"],
    ["unquoted identifier key", '{city:"Seoul"}'],
    ["curly/smart quotes", "{“city”:“Seoul”}"],
    ["unquoted key + trailing comma", '{city:"Seoul",}']
  ])("recovers a dropped tool call from: %s", (_label, raw) => {
    expect(recoverToolArgsJson(raw)).toEqual({ city: "Seoul" });
  });

  it("still parses already-valid JSON (regression: fenced + plain)", () => {
    expect(recoverToolArgsJson('{"city":"Seoul"}')).toEqual({ city: "Seoul" });
    expect(recoverToolArgsJson('```json\n{"city":"Seoul"}\n```')).toEqual({ city: "Seoul" });
  });

  it("NEVER breaks a valid value: an apostrophe inside a double-quoted string is preserved", () => {
    expect(recoverToolArgsJson('{"note":"it\'s fine","city":"Seoul"}')).toEqual({ note: "it's fine", city: "Seoul" });
  });

  it("returns undefined for unrecoverable junk (no wrong value invented)", () => {
    expect(recoverToolArgsJson("not json at all")).toBeUndefined();
    expect(recoverToolArgsJson("")).toBeUndefined();
  });
});
