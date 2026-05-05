import { describe, expect, it } from "vitest";
import { createRunId } from "../src/index.js";

describe("createRunId", () => {
  it("uses a readable prefix", () => {
    expect(createRunId("muse")).toMatch(/^muse_[0-9a-f-]{36}$/);
  });
});
