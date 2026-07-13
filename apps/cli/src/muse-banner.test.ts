import { describe, expect, it } from "vitest";

import { MUSE_TAGLINE } from "./muse-identity.js";
import { renderMuseBanner } from "./muse-banner.js";

describe("renderMuseBanner", () => {
  it("renders the MUSE wordmark and the identity tagline (plain mode)", () => {
    const out = renderMuseBanner();
    // A stable row from the block wordmark.
    expect(out).toContain("███████╗");
    expect(out).toContain(MUSE_TAGLINE);
    // the splash leads with the learns-you / local-first identity, not a generic label
    expect(out).toContain("learns you");
    // Tagline shares the art's 2-space left margin (aligned with the recap /
    // input column below it) — exactly 2 spaces, not the old stray 3.
    expect(out).toContain(`\n  ${MUSE_TAGLINE}`);
    expect(out).not.toContain(`\n   ${MUSE_TAGLINE}`);
    // No decorative cyan rule under the tagline.
    expect(out).not.toContain("────");
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

    const coloured = renderMuseBanner({ env: {}, force: true });
    expect(coloured).toContain("\x1b[38"); // truecolor mascot art when colour is forced
  });
});
