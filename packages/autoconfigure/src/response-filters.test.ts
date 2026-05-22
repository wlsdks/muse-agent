import { describe, expect, it } from "vitest";

import type { MuseEnvironment } from "./index.js";
import { responseLocales } from "./response-filters.js";

const env = (value?: string): MuseEnvironment =>
  ({ MUSE_RESPONSE_LOCALES: value } as unknown as MuseEnvironment);

describe("responseLocales", () => {
  it("defaults to both ko and en when unset", () => {
    expect([...responseLocales(env(undefined))].sort()).toEqual(["en", "ko"]);
  });

  it("honours a single explicit locale", () => {
    expect([...responseLocales(env("ko"))]).toEqual(["ko"]);
    expect([...responseLocales(env("en"))]).toEqual(["en"]);
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect([...responseLocales(env(" KO , En "))].sort()).toEqual(["en", "ko"]);
  });

  it("drops unrecognized entries but keeps the valid ones", () => {
    expect([...responseLocales(env("fr,ko,de"))]).toEqual(["ko"]);
  });

  it("falls back to both when NO entry is a recognized locale (a typo must not silently disable locale-gated filters)", () => {
    expect([...responseLocales(env("english"))].sort()).toEqual(["en", "ko"]);
    expect([...responseLocales(env("fr,de"))].sort()).toEqual(["en", "ko"]);
    expect([...responseLocales(env("   "))].sort()).toEqual(["en", "ko"]);
  });
});
