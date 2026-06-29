import { describe, expect, it } from "vitest";

import { sanitizeToolCallName } from "../src/index.js";

describe("sanitizeToolCallName — repair tool-NAME malformations (sibling of arg repair; openclaw tool-call-repair, MIT)", () => {
  it.each([
    ["trailing call-paren", "muse.math.evaluate()", "muse.math.evaluate"],
    ["paren with args", "evaluate(args)", "evaluate"],
    ["surrounding double quotes", "\"math_eval\"", "math_eval"],
    ["surrounding single quotes", "'math_eval'", "math_eval"],
    ["echoed functions. prefix", "functions.math_eval", "math_eval"],
    ["whitespace (regression)", "  math_eval  ", "math_eval"]
  ])("recovers the registered name from: %s", (_l, raw, expected) => {
    expect(sanitizeToolCallName(raw)).toBe(expected);
  });
  it("leaves a clean namespaced name unchanged (no over-strip)", () => {
    expect(sanitizeToolCallName("muse.math.evaluate")).toBe("muse.math.evaluate");
    expect(sanitizeToolCallName("home_state")).toBe("home_state");
  });
  it("empty / junk → unknown (no invented name)", () => {
    expect(sanitizeToolCallName("")).toBe("unknown");
    expect(sanitizeToolCallName(undefined)).toBe("unknown");
  });
});
