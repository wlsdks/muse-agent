import { describe, expect, it } from "vitest";

import { renderMuseBanner } from "./muse-banner.js";

describe("renderMuseBanner", () => {
  it("renders the MUSE wordmark, the music motif, and the tagline (plain mode)", () => {
    const out = renderMuseBanner();
    // The figlet-style wordmark closing row is a stable anchor.
    expect(out).toContain("|_|  |_|\\___/|___/___|");
    expect(out).toContain("♪ ♫ ♬");
    expect(out).toContain("the muse of every craft — your AI conductor");
    // Leading + trailing blank lines so the prompt has room.
    expect(out.startsWith("\n")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("includes status / subStatus / hint lines only when provided", () => {
    const full = renderMuseBanner({ status: "user: stark", subStatus: "remembered: 3", hint: "/help" });
    expect(full).toContain("user: stark");
    expect(full).toContain("remembered: 3");
    expect(full).toContain("/help");

    const bare = renderMuseBanner();
    expect(bare).not.toContain("remembered:");
    expect(bare).not.toContain("/help");
  });

  it("emits no ANSI escapes in plain mode but colours when forced", () => {
    const plain = renderMuseBanner({ isTty: false });
    expect(plain).not.toContain("\x1b[");

    const coloured = renderMuseBanner({ force: true });
    expect(coloured).toContain("\x1b[36m"); // cyan wordmark/notes
  });
});
