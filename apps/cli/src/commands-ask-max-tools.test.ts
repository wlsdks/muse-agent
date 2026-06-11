import { describe, expect, it } from "vitest";

import { resolveAskMaxTools } from "./commands-ask.js";

describe("resolveAskMaxTools — the --with-tools exposure cap (tool-calling.md: small sets select better)", () => {
  it("defaults to 10 when unset", () => {
    expect(resolveAskMaxTools({})).toBe(10);
  });

  it("honours MUSE_ASK_MAX_TOOLS", () => {
    expect(resolveAskMaxTools({ MUSE_ASK_MAX_TOOLS: "7" })).toBe(7);
  });

  it("0 or 'off' disables the cap (undefined = expose everything)", () => {
    expect(resolveAskMaxTools({ MUSE_ASK_MAX_TOOLS: "0" })).toBeUndefined();
    expect(resolveAskMaxTools({ MUSE_ASK_MAX_TOOLS: "off" })).toBeUndefined();
  });

  it("garbage falls back to the default", () => {
    expect(resolveAskMaxTools({ MUSE_ASK_MAX_TOOLS: "many" })).toBe(10);
    expect(resolveAskMaxTools({ MUSE_ASK_MAX_TOOLS: "-3" })).toBe(10);
  });
});
