import { describe, expect, it } from "vitest";

import { resolveDefaultUserKey } from "./user-id.js";

describe("resolveDefaultUserKey", () => {
  it("falls back to 'default' when every link is unset", () => {
    expect(resolveDefaultUserKey({ env: {} })).toBe("default");
  });

  it("honours MUSE_USER_ID when set", () => {
    expect(resolveDefaultUserKey({ env: { MUSE_USER_ID: "stark" } })).toBe("stark");
  });

  it("falls through to USER when MUSE_USER_ID is unset", () => {
    expect(resolveDefaultUserKey({ env: { USER: "jinan" } })).toBe("jinan");
  });

  it("treats an empty / whitespace-only MUSE_USER_ID as unset", () => {
    expect(resolveDefaultUserKey({ env: { MUSE_USER_ID: "", USER: "fallback" } })).toBe("fallback");
    expect(resolveDefaultUserKey({ env: { MUSE_USER_ID: "   ", USER: "fallback" } })).toBe("fallback");
    expect(resolveDefaultUserKey({ env: { MUSE_USER_ID: "" } })).toBe("default");
    expect(resolveDefaultUserKey({ env: { MUSE_USER_ID: "", USER: "" } })).toBe("default");
  });

  it("explicit override beats every env link", () => {
    expect(
      resolveDefaultUserKey({
        override: "override-id",
        env: { MUSE_USER_ID: "env-muse", USER: "env-user" }
      })
    ).toBe("override-id");
  });

  it("an empty override falls through to env (does not lock in the bucket)", () => {
    expect(resolveDefaultUserKey({ override: "", env: { MUSE_USER_ID: "env-muse" } })).toBe("env-muse");
    expect(resolveDefaultUserKey({ override: "   ", env: { MUSE_USER_ID: "env-muse" } })).toBe("env-muse");
  });

  it("trims surrounding whitespace before returning", () => {
    expect(resolveDefaultUserKey({ env: { MUSE_USER_ID: "  stark  " } })).toBe("stark");
  });
});
