import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composeKey, envValue } from "./commands-remember.js";

// composeKey / envValue read MUSE_USER_ID / USER / MUSE_PERSONA. Snapshot and
// restore them so a test never leaks into the next one (or the dev's shell).
const TRACKED = ["MUSE_USER_ID", "USER", "MUSE_PERSONA"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of TRACKED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TRACKED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("envValue", () => {
  it("returns undefined for an unset variable", () => {
    expect(envValue("MUSE_USER_ID")).toBeUndefined();
  });

  it("returns undefined for a whitespace-only value", () => {
    process.env.MUSE_USER_ID = "   ";
    expect(envValue("MUSE_USER_ID")).toBeUndefined();
  });

  it("trims and returns a real value", () => {
    process.env.MUSE_USER_ID = "  alice  ";
    expect(envValue("MUSE_USER_ID")).toBe("alice");
  });
});

describe("composeKey — the user-memory bucket key", () => {
  it("uses an explicit user id verbatim", () => {
    expect(composeKey("bob", undefined)).toBe("bob");
  });

  it("falls back to MUSE_USER_ID when no explicit user is given", () => {
    process.env.MUSE_USER_ID = "carol";
    expect(composeKey(undefined, undefined)).toBe("carol");
  });

  it("falls back to $USER when MUSE_USER_ID is absent", () => {
    process.env.USER = "dave";
    expect(composeKey(undefined, undefined)).toBe("dave");
  });

  it("falls back to 'default' when nothing identifies the user", () => {
    expect(composeKey(undefined, undefined)).toBe("default");
  });

  it("prefers the explicit user over MUSE_USER_ID and $USER", () => {
    process.env.MUSE_USER_ID = "carol";
    process.env.USER = "dave";
    expect(composeKey("bob", undefined)).toBe("bob");
  });

  it("appends an explicit persona slot as base@persona", () => {
    expect(composeKey("bob", "work")).toBe("bob@work");
  });

  it("appends the MUSE_PERSONA slot when no explicit persona is passed", () => {
    process.env.MUSE_PERSONA = "home";
    expect(composeKey("bob", undefined)).toBe("bob@home");
  });

  it("composes the resolved base with the resolved persona together", () => {
    process.env.MUSE_USER_ID = "carol";
    expect(composeKey(undefined, "work")).toBe("carol@work");
  });
});
