import { describe, expect, it } from "vitest";

import { createTextUtilsMcpServer } from "../src/loopback-text-utils-server.js";

const tool = (name: string) => {
  const found = createTextUtilsMcpServer().tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
};

describe("muse.text#stats", () => {
  it("counts words, characters, and lines for plain multi-line text", () => {
    expect(tool("stats").execute({ text: "hello world\nfrom muse" })).toMatchObject({
      characters: 21,
      lines: 2,
      words: 4,
    });
  });

  it("collapses irregular / leading / trailing whitespace when counting words", () => {
    expect(tool("stats").execute({ text: "  a\t b   c \n" })).toMatchObject({ words: 3 });
  });

  it("treats whitespace-only and empty input as all-zero", () => {
    expect(tool("stats").execute({ text: "   " })).toEqual({ characters: 0, lines: 0, words: 0 });
    expect(tool("stats").execute({ text: "" })).toEqual({ characters: 0, lines: 0, words: 0 });
  });

  it("counts astral code points as one character each (consistent with #reverse)", () => {
    expect(tool("stats").execute({ text: "a🙂b" })).toMatchObject({ characters: 3 });
    expect(tool("stats").execute({ text: "🙂🙂" })).toMatchObject({ characters: 2 });
  });
});

describe("muse.text#reverse", () => {
  it("reverses ASCII text", () => {
    expect(tool("reverse").execute({ text: "muse" })).toEqual({ reversed: "esum" });
  });

  it("preserves astral code points instead of splitting surrogate pairs", () => {
    expect(tool("reverse").execute({ text: "a🙂b" })).toEqual({ reversed: "b🙂a" });
  });

  it("returns an empty string for empty input", () => {
    expect(tool("reverse").execute({ text: "" })).toEqual({ reversed: "" });
  });
});
