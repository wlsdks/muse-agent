import { describe, expect, it } from "vitest";

import { parseLimit, scrubResultText } from "./commands-search.js";

describe("scrubResultText (web-result → notes scrub)", () => {
  it("collapses whitespace so a multi-line title can't splice a fake markdown heading", () => {
    expect(scrubResultText("Foo\n\n## Injected heading\nbar")).toBe("Foo ## Injected heading bar");
    expect(scrubResultText("a\t\tb   c")).toBe("a b c");
  });

  it("strips ESC / C0 / C1 / DEL control bytes", () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const C1CSI = String.fromCharCode(0x9b);
    const NUL = String.fromCharCode(0);
    const DEL = String.fromCharCode(0x7f);
    const controlByte = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "u");
    const out = scrubResultText(`hi${ESC}]0;x${BEL} ${C1CSI}y ${NUL}${DEL}z`);
    expect(controlByte.test(out)).toBe(false);
  });

  it("redacts a credential shape in the result text", () => {
    // Split the prefix so the source has no contiguous token for
    // GitHub push-protection (same trick the shared tests use).
    const tok = `ghp${"_"}abcdefghijklmnopqrstuvwxyzABCDEF`;
    expect(scrubResultText(`leak ${tok} here`)).toBe("leak [redacted-github-pat] here");
  });

  it("control-only / whitespace-only / empty → empty (title falls back to (untitled))", () => {
    expect(scrubResultText("")).toBe("");
    expect(scrubResultText("   \n\t ")).toBe("");
    expect(scrubResultText(String.fromCharCode(27) + String.fromCharCode(0))).toBe("");
  });
});

describe("parseLimit (muse search --limit)", () => {
  it("absent or blank → the fallback", () => {
    expect(parseLimit(undefined, 10, 50)).toBe(10);
    expect(parseLimit("", 10, 50)).toBe(10);
    expect(parseLimit("   ", 10, 50)).toBe(10);
  });

  it("accepts a genuine number, truncating and clamping to cap", () => {
    expect(parseLimit("5", 10, 50)).toBe(5);
    expect(parseLimit(" 25 ", 10, 50)).toBe(25);
    expect(parseLimit("25.9", 10, 50)).toBe(25);
    expect(parseLimit("999", 10, 50)).toBe(50); // clamp high
    expect(parseLimit("1", 10, 50)).toBe(1);
  });

  it("rejects a unit slip / non-numeric / below-1 instead of silently defaulting", () => {
    expect(() => parseLimit("5abc", 10, 50)).toThrow(/--limit must be an integer in \[1, 50\]/u);
    expect(() => parseLimit("abc", 10, 50)).toThrow(/got 'abc'/u);
    expect(() => parseLimit("0", 10, 50)).toThrow(/\[1, 50\]/u);
    expect(() => parseLimit("-5", 10, 50)).toThrow(/got '-5'/u);
    expect(() => parseLimit("0.5", 10, 50)).toThrow(/\[1, 50\]/u);
    expect(() => parseLimit("1O", 10, 50)).toThrow(/got '1O'/u);
  });
});
