import { describe, expect, it } from "vitest";

import { detectInlineImageSupport, wrapForTmux } from "./commands-show.js";

describe("wrapForTmux", () => {
  it("returns the sequence unchanged when not inside tmux", () => {
    const seq = "\x1b]1337;File=:abc\x07";
    expect(wrapForTmux(seq, false)).toBe(seq);
  });
  it("wraps in the tmux passthrough envelope and doubles ESC bytes", () => {
    const out = wrapForTmux("\x1bA", true);
    expect(out.startsWith("\x1bPtmux;")).toBe(true);
    expect(out.endsWith("\x1b\\")).toBe(true);
    expect(out).toContain("\x1b\x1bA");
  });
});

describe("detectInlineImageSupport", () => {
  it("is false when TERM_PROGRAM is absent, blank, or unknown", () => {
    expect(detectInlineImageSupport({} as NodeJS.ProcessEnv)).toBe(false);
    expect(detectInlineImageSupport({ TERM_PROGRAM: "   " } as NodeJS.ProcessEnv)).toBe(false);
    expect(detectInlineImageSupport({ TERM_PROGRAM: "totally-unknown-terminal" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
