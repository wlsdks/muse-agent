import { describe, expect, it } from "vitest";

import { MUSE_TAGLINE } from "./muse-identity.js";
import { createProgram, formatUnknownCommand, museQuickstartHelp } from "./program.js";
import type { ProgramIO } from "./program.js";

describe("formatUnknownCommand — typo nudge vs discovery on-ramp", () => {
  const known = ["chat", "ask", "status", "today", "remember", "setup", "calendar", "recall", "doctor"];

  it("nudges 'Did you mean' for a near-miss typo (no popular dump)", () => {
    const out = formatUnknownCommand("statuss", known);
    expect(out).toContain("error: unknown command 'statuss'");
    expect(out).toContain("Did you mean 'muse status'?");
    expect(out).not.toContain("Popular commands:");
  });

  it("offers a Popular-commands discovery on-ramp when nothing is close", () => {
    const out = formatUnknownCommand("zqxwv", known);
    expect(out).toContain("error: unknown command 'zqxwv'");
    expect(out).not.toContain("Did you mean");
    expect(out).toContain("Popular commands:");
    expect(out).toContain("muse chat");
    expect(out).toContain("muse status");
  });

  it("only names commands that exist in the live registry (no fabricated command)", () => {
    // a registry missing most populars → the hint lists only the present ones
    const out = formatUnknownCommand("zqxwv", ["ask", "doctor"]);
    expect(out).toContain("muse ask");
    expect(out).not.toContain("muse chat");   // 'chat' not registered here
    expect(out).not.toContain("muse status");
  });
});

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

describe("muse --help command list is sorted (scannable, not insertion-order)", () => {
  it("lists subcommands alphabetically — a name out of insertion order proves the sort", () => {
    const out: string[] = [];
    const io: ProgramIO = { stderr: () => undefined, stdout: (s) => { out.push(s); } };
    const program = createProgram(io);
    program.outputHelp();
    const help = out.join("");
    // `chat` is registered AFTER `spec` (insertion order), so chat-before-spec
    // can only hold when the list is alphabetically sorted.
    expect(help.indexOf("\n  chat")).toBeGreaterThanOrEqual(0);
    expect(help.indexOf("\n  spec")).toBeGreaterThanOrEqual(0);
    expect(help.indexOf("\n  chat")).toBeLessThan(help.indexOf("\n  spec"));
    // a second independent pair
    expect(help.indexOf("\n  ask")).toBeLessThan(help.indexOf("\n  status"));
  });
});
