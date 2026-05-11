import { describe, expect, it } from "vitest";

import { parseRuntimeSettingType as parseStrict } from "../src/server-input-utils.js";
import { parseRuntimeSettingType as parseCompat } from "../src/compat-routes.js";

describe("parseRuntimeSettingType — single shared implementation", () => {
  it("server-input-utils and compat-routes are the same function reference", () => {
    expect(parseStrict).toBe(parseCompat);
  });

  for (const valid of ["string", "number", "boolean", "json"] as const) {
    it(`accepts canonical ${valid}`, () => {
      expect(parseStrict(valid)).toBe(valid);
    });
  }

  it("trims whitespace before matching", () => {
    expect(parseStrict("  boolean  ")).toBe("boolean");
  });

  it("normalises case before matching", () => {
    expect(parseStrict("Boolean")).toBe("boolean");
    expect(parseStrict("JSON")).toBe("json");
  });

  it("returns undefined for unknown values", () => {
    expect(parseStrict("date")).toBeUndefined();
    expect(parseStrict("")).toBeUndefined();
    expect(parseStrict(123)).toBeUndefined();
    expect(parseStrict(undefined)).toBeUndefined();
    expect(parseStrict(null)).toBeUndefined();
  });
});
