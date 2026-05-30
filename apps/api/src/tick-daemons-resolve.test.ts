import { homedir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAmbientSignalFile, resolveProactiveTrustFile } from "./tick-daemons.js";

// Direct coverage for the daemon state-file resolvers (untested). The safety
// property is the precedence + the REFUSAL to default to the filesystem root:
// an explicit MUSE_*_FILE override wins, else $HOME/.muse/<file>, else the OS
// home — never "/" (which would scatter .muse/*.json at the root).

let savedHome: string | undefined;
beforeEach(() => { savedHome = process.env.HOME; });
afterEach(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });

describe("resolveAmbientSignalFile / resolveProactiveTrustFile", () => {
  it("honor an explicit override env var first (without touching HOME)", () => {
    expect(resolveAmbientSignalFile({ MUSE_AMBIENT_FILE: "/tmp/x/amb.json" })).toBe("/tmp/x/amb.json");
    expect(resolveProactiveTrustFile({ MUSE_PROACTIVE_TRUST_FILE: "/tmp/x/tr.json" })).toBe("/tmp/x/tr.json");
  });

  it("fall back to $HOME/.muse/<file> when no override", () => {
    process.env.HOME = "/tmp/fakehome";
    expect(resolveAmbientSignalFile({})).toBe("/tmp/fakehome/.muse/ambient.json");
    expect(resolveProactiveTrustFile({})).toBe("/tmp/fakehome/.muse/proactive-trust.json");
  });

  it("fall back to the OS home dir when HOME is unset — never the filesystem root", () => {
    delete process.env.HOME;
    const ambient = resolveAmbientSignalFile({});
    expect(ambient.startsWith(homedir())).toBe(true);
    expect(ambient.endsWith("/.muse/ambient.json")).toBe(true);
    expect(ambient.startsWith("/.muse")).toBe(false); // not rooted at "/"
    expect(resolveProactiveTrustFile({}).endsWith("/.muse/proactive-trust.json")).toBe(true);
  });
});
