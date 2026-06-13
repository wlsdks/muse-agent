import { describe, expect, it } from "vitest";

import { escapeRegex } from "../src/index.js";

describe("escapeRegex", () => {
  it("escapes every regex metacharacter so the string matches literally", () => {
    const raw = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    const re = new RegExp(`^${escapeRegex(raw)}$`, "u");
    expect(re.test(raw)).toBe(true);
    // a non-identical string must NOT match (the metachars are literal, not wildcards)
    expect(re.test("aXbXcXdXeXfXgXhXiXjXkXlXmXnXo")).toBe(false);
  });

  it("leaves a string with no metacharacters unchanged", () => {
    expect(escapeRegex("hello world 123")).toBe("hello world 123");
  });

  it("prefixes each metacharacter with a backslash", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
    expect(escapeRegex("(x)")).toBe("\\(x\\)");
  });
});
