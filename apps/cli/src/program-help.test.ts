import { describe, expect, it } from "vitest";

import { MUSE_TAGLINE } from "./muse-identity.js";
import { createProgram, museQuickstartHelp } from "./program.js";
import type { ProgramIO } from "./program.js";

describe("MUSE_TAGLINE (first-screen identity)", () => {
  it("states the learns-you, local-first identity rather than a generic label", () => {
    expect(MUSE_TAGLINE.toLowerCase()).toContain("learns you");
    expect(MUSE_TAGLINE.toLowerCase()).toContain("local-first");
    // the stale generic self-description must not come back
    expect(MUSE_TAGLINE).not.toContain("Model-agnostic");
  });
});

describe("muse --help header (wiring)", () => {
  it("uses the identity tagline as the program description on the first screen", () => {
    const out: string[] = [];
    const io: ProgramIO = { stderr: () => undefined, stdout: (s) => { out.push(s); } };
    const program = createProgram(io);
    program.outputHelp();
    expect(out.join("")).toContain(MUSE_TAGLINE);
  });
});

describe("museQuickstartHelp", () => {
  it("lists the real fastest-path commands in value order", () => {
    const help = museQuickstartHelp();
    for (const cmd of ["muse setup local", "muse remember", "muse status"]) {
      expect(help).toContain(cmd);
    }
    // setup-before-status ordering (you configure a model before the dashboard means anything)
    expect(help.indexOf("muse setup local")).toBeLessThan(help.indexOf("muse status"));
  });

  it("leads with the local-first identity, not a cloud default", () => {
    const help = museQuickstartHelp();
    expect(help).toContain("local-first");
    expect(help).toMatch(/LOCAL model by default/);
    expect(help).toContain("cloud egress is refused");
  });
});

describe("muse --help first screen (wiring)", () => {
  it("appends the quickstart block to the root help output", () => {
    const out: string[] = [];
    const io: ProgramIO = { stderr: () => undefined, stdout: (s) => { out.push(s); } };
    const program = createProgram(io);
    program.outputHelp();
    const text = out.join("");
    expect(text).toContain("Quickstart (local-first");
    expect(text).toContain("muse setup local");
  });
});
