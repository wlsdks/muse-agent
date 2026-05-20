import { describe, expect, it } from "vitest";

import { resolveProactiveSidecarFile } from "../src/tick-daemons.js";

function withProcessHome(home: string | undefined, fn: () => void): void {
  const prev = process.env.HOME;
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

describe("resolveProactiveSidecarFile — refuses to default to filesystem-root /.muse/", () => {
  it("uses MUSE_PROACTIVE_SIDECAR_FILE verbatim when set non-empty", () => {
    expect(resolveProactiveSidecarFile({ MUSE_PROACTIVE_SIDECAR_FILE: "/var/lib/muse/p.json" }))
      .toBe("/var/lib/muse/p.json");
    expect(resolveProactiveSidecarFile({ MUSE_PROACTIVE_SIDECAR_FILE: "  /trimmed.json  " }))
      .toBe("/trimmed.json");
  });

  it("falls back to HOME/.muse/proactive-fired.json when env override is missing or whitespace", () => {
    withProcessHome("/u/jinan", () => {
      expect(resolveProactiveSidecarFile({})).toBe("/u/jinan/.muse/proactive-fired.json");
      expect(resolveProactiveSidecarFile({ MUSE_PROACTIVE_SIDECAR_FILE: "   " }))
        .toBe("/u/jinan/.muse/proactive-fired.json");
    });
  });

  it("falls through to os.homedir() (or throws) when HOME is whitespace-only — does NOT produce '/.muse/proactive-fired.json' at filesystem root or '   /.muse/...' under whitespace", () => {
    withProcessHome("   ", () => {
      let path: string | undefined;
      let thrown: Error | undefined;
      try { path = resolveProactiveSidecarFile({}); }
      catch (cause) { thrown = cause as Error; }
      if (thrown) {
        expect(thrown.message).toMatch(/Cannot resolve home directory.*MUSE_PROACTIVE_SIDECAR_FILE/u);
        return;
      }
      expect(path).toBeDefined();
      expect(path, "no leading whitespace in resolved path").not.toMatch(/^\s/u);
      expect(path, "no bare filesystem-root .muse/").not.toBe("/.muse/proactive-fired.json");
      expect(path).toMatch(/\/\.muse\/proactive-fired\.json$/u);
    });
  });
});
