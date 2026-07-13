import { describe, expect, it } from "vitest";

import { colorize, detectTerminalBackground } from "../src/tty-color.js";

describe("detectTerminalBackground", () => {
  it("reads the background field of COLORFGBG", () => {
    expect(detectTerminalBackground({ COLORFGBG: "15;0" })).toBe("dark"); // bg 0 = black
    expect(detectTerminalBackground({ COLORFGBG: "0;15" })).toBe("light"); // bg 15 = white
    expect(detectTerminalBackground({ COLORFGBG: "0;7" })).toBe("light"); // bg 7 = light grey
    expect(detectTerminalBackground({ COLORFGBG: "15;8" })).toBe("dark"); // bg 8 = dark grey
  });

  it("handles rxvt's three-field form (fg;;bg) — background is the last field", () => {
    expect(detectTerminalBackground({ COLORFGBG: "0;default;15" })).toBe("light");
  });

  it("returns unknown when absent, single-field, or non-numeric", () => {
    expect(detectTerminalBackground({})).toBe("unknown");
    expect(detectTerminalBackground({ COLORFGBG: "7" })).toBe("unknown"); // fg only
    expect(detectTerminalBackground({ COLORFGBG: "default;default" })).toBe("unknown");
  });
});

describe("colorize background-aware contrast", () => {
  it("suppresses dim on a known light background (grey-on-white is unreadable)", () => {
    expect(colorize("note", "dim", { env: {}, force: true, background: "light" })).toBe("note"); // plain
  });

  it("still dims on dark / unknown backgrounds", () => {
    expect(colorize("note", "dim", { env: {}, force: true, background: "dark" })).toContain("\x1b[2m");
    expect(colorize("note", "dim", { env: {}, force: true, background: "unknown" })).toContain("\x1b[2m");
  });

  it("only affects dim — other colours render normally even on a light background", () => {
    expect(colorize("warn", "red", { env: {}, force: true, background: "light" })).toBe("\x1b[31mwarn\x1b[0m");
  });

  it("still respects NO_COLOR / non-TTY (dim returns plain regardless of background)", () => {
    expect(colorize("note", "dim", { isTty: false, background: "dark" })).toBe("note");
  });
});
