import { afterEach, describe, expect, it } from "vitest";

import { resetCliContext, updateCliContext } from "./cli-context.js";
import { colorAllowed, colorize } from "./tty-color.js";

describe("colorAllowed — clig.dev colour precedence", () => {
  afterEach(() => {
    resetCliContext();
  });

  const clean: NodeJS.ProcessEnv = {};

  it("NO_COLOR wins over everything (even FORCE_COLOR + force + TTY)", () => {
    expect(colorAllowed({ env: { NO_COLOR: "1", FORCE_COLOR: "1" }, force: true, isTty: true })).toBe(false);
    expect(colorAllowed({ env: { NO_COLOR: "" }, isTty: true })).toBe(false); // any value, incl. empty
  });

  it("FORCE_COLOR truthy forces colour on (no TTY), but an explicit --no-color beats it", () => {
    expect(colorAllowed({ env: { FORCE_COLOR: "1" }, isTty: false })).toBe(true);
    expect(colorAllowed({ env: { FORCE_COLOR: "3" }, isTty: false })).toBe(true);
    expect(colorAllowed({ env: { FORCE_COLOR: "true" }, isTty: false })).toBe(true);
    // --no-color now sits ABOVE FORCE_COLOR: a user who typed it wins.
    expect(colorAllowed({ env: { FORCE_COLOR: "1" }, isTty: false, noColor: true })).toBe(false);
  });

  it("FORCE_COLOR falsy values ('0'/'false'/'') do not force colour", () => {
    expect(colorAllowed({ env: { FORCE_COLOR: "0" }, isTty: false })).toBe(false);
    expect(colorAllowed({ env: { FORCE_COLOR: "false" }, isTty: false })).toBe(false);
    expect(colorAllowed({ env: { FORCE_COLOR: "" }, isTty: false })).toBe(false);
  });

  it("--no-color request disables colour (above FORCE_COLOR, below NO_COLOR)", () => {
    expect(colorAllowed({ env: clean, isTty: true, noColor: true })).toBe(false);
    // beats an ambient FORCE_COLOR…
    expect(colorAllowed({ env: { FORCE_COLOR: "1" }, isTty: true, noColor: true })).toBe(false);
    // …but NO_COLOR still outranks --no-color (both mean "no colour" anyway).
    expect(colorAllowed({ env: { NO_COLOR: "1" }, isTty: true, noColor: true })).toBe(false);
    // reads the shared cli-context when the option isn't passed explicitly
    updateCliContext({ noColor: true });
    expect(colorAllowed({ env: { FORCE_COLOR: "1" }, isTty: true })).toBe(false);
  });

  it("TERM=dumb never colours, even on a TTY", () => {
    expect(colorAllowed({ env: { TERM: "dumb" }, isTty: true })).toBe(false);
    expect(colorAllowed({ env: { TERM: "DUMB" }, isTty: true })).toBe(false);
  });

  it("otherwise follows the TTY: coloured on a TTY, plain when piped", () => {
    expect(colorAllowed({ env: { TERM: "xterm-256color" }, isTty: true })).toBe(true);
    expect(colorAllowed({ env: clean, isTty: true })).toBe(true);
    expect(colorAllowed({ env: clean, isTty: false })).toBe(false);
  });

  it("legacy `force` still forces colour on for golden tests", () => {
    expect(colorAllowed({ env: clean, force: true, isTty: false })).toBe(true);
  });
});

describe("colorize honours colorAllowed", () => {
  it("wraps when allowed and passes through when disabled", () => {
    const forced = colorize("hi", "red", { env: {}, force: true, isTty: false });
    expect(forced).toContain("hi");
    expect(forced).toContain("\x1b[31m");
    const plain = colorize("hi", "red", { env: { NO_COLOR: "1" }, isTty: true });
    expect(plain).toBe("hi");
  });
});
