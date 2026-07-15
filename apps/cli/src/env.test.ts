import { describe, expect, it } from "vitest";

import { readNonEmptyEnv } from "./env.js";

describe("readNonEmptyEnv", () => {
  it("returns a trimmed non-empty value", () => {
    expect(readNonEmptyEnv({ MUSE_USER_ID: "  jinan  " }, "MUSE_USER_ID")).toBe("jinan");
  });

  it("treats missing and blank values as absent", () => {
    expect(readNonEmptyEnv({}, "MUSE_USER_ID")).toBeUndefined();
    expect(readNonEmptyEnv({ MUSE_USER_ID: "  " }, "MUSE_USER_ID")).toBeUndefined();
  });
});
