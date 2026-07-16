import { describe, expect, it } from "vitest";

import { readCompanionSeed, stripCompanionSeed } from "./companion-seed.js";

describe("readCompanionSeed", () => {
  it("reads the seed from a query string", () => {
    expect(readCompanionSeed("?companion_seed=weekend%20plans")).toBe("weekend plans");
  });

  it("reads a Korean seed", () => {
    expect(readCompanionSeed(`?companion_seed=${encodeURIComponent("보리 산책")}`)).toBe("보리 산책");
  });

  it("returns undefined when the param is absent", () => {
    expect(readCompanionSeed("")).toBeUndefined();
    expect(readCompanionSeed("?view=chat")).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace-only seed", () => {
    expect(readCompanionSeed("?companion_seed=")).toBeUndefined();
    expect(readCompanionSeed("?companion_seed=%20%20")).toBeUndefined();
  });

  it("caps an oversized seed instead of passing it through", () => {
    const huge = "a".repeat(10_000);
    expect(readCompanionSeed(`?companion_seed=${huge}`)?.length).toBe(2000);
  });

  it("coexists with other params", () => {
    expect(readCompanionSeed("?lang=ko&companion_seed=hello&x=1")).toBe("hello");
  });
});

describe("stripCompanionSeed", () => {
  it("removes only the seed param and keeps the rest of the URL", () => {
    const url = new URL("http://127.0.0.1:3030/?lang=ko&companion_seed=hello");
    const stripped = stripCompanionSeed(url);
    expect(stripped.searchParams.get("companion_seed")).toBeNull();
    expect(stripped.searchParams.get("lang")).toBe("ko");
    expect(stripped.pathname).toBe("/");
  });

  it("does not mutate the input URL", () => {
    const url = new URL("http://127.0.0.1:3030/?companion_seed=hello");
    stripCompanionSeed(url);
    expect(url.searchParams.get("companion_seed")).toBe("hello");
  });
});
