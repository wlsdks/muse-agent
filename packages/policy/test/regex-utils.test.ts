import { describe, expect, it } from "vitest";
import { toGlobal } from "../src/regex-utils.js";

describe("toGlobal", () => {
  it("adds the g flag when the source regex lacks one", () => {
    const result = toGlobal(/abc/i);
    expect(result.flags).toBe("gi");
    expect(result.source).toBe("abc");
  });

  it("preserves an already-global regex unchanged", () => {
    const result = toGlobal(/abc/gi);
    expect(result.flags).toBe("gi");
    expect(result.source).toBe("abc");
  });

  it("preserves the regex source exactly", () => {
    const source = "\\d{3}-\\d{4}";
    const result = toGlobal(new RegExp(source));
    expect(result.source).toBe(source);
  });

  it("returns a fresh RegExp instance (not the same object)", () => {
    const original = /x/;
    const result = toGlobal(original);
    expect(result).not.toBe(original);
  });

  it("supports repeated global matching via lastIndex advancement", () => {
    const result = toGlobal(/a/);
    const text = "aaa";
    expect(result.exec(text)?.index).toBe(0);
    expect(result.exec(text)?.index).toBe(1);
    expect(result.exec(text)?.index).toBe(2);
    expect(result.exec(text)).toBeNull();
  });
});
