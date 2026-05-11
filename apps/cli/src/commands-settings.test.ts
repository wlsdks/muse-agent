import { describe, expect, it } from "vitest";

import { inferSettingType } from "./commands-settings.js";

describe("inferSettingType", () => {
  it("recognises boolean literals", () => {
    expect(inferSettingType("true")).toBe("boolean");
    expect(inferSettingType("false")).toBe("boolean");
    expect(inferSettingType("  true  ")).toBe("boolean");
  });

  it("recognises integer + decimal numeric literals", () => {
    expect(inferSettingType("42")).toBe("number");
    expect(inferSettingType("-1")).toBe("number");
    expect(inferSettingType("3.14")).toBe("number");
  });

  it("recognises JSON object/array literals", () => {
    expect(inferSettingType('{"a":1}')).toBe("json");
    expect(inferSettingType("[1,2,3]")).toBe("json");
  });

  it("falls back to string for unparseable literals", () => {
    expect(inferSettingType("hello world")).toBe("string");
    expect(inferSettingType("{not-json}")).toBe("string");
    expect(inferSettingType("True")).toBe("string");
    expect(inferSettingType("")).toBe("string");
  });
});
