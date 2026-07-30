import { describe, expect, it } from "vitest";

import { apiWasExplicitlyConfigured } from "./commands-today.js";

describe("apiWasExplicitlyConfigured — file-backed mode stays silent; an explicit API warns when down", () => {
  it("false when neither the flag nor MUSE_API_URL is set (the default CLI user)", () => {
    expect(apiWasExplicitlyConfigured(undefined, undefined)).toBe(false);
    expect(apiWasExplicitlyConfigured("", "")).toBe(false);
    expect(apiWasExplicitlyConfigured("  ", undefined)).toBe(false);
  });

  it("true when --api-url is passed", () => {
    expect(apiWasExplicitlyConfigured("http://10.0.0.5:3030", undefined)).toBe(true);
  });

  it("true when MUSE_API_URL is set", () => {
    expect(apiWasExplicitlyConfigured(undefined, "http://10.0.0.5:3030")).toBe(true);
  });

  it("the flag takes precedence but either non-empty source counts", () => {
    expect(apiWasExplicitlyConfigured("http://flag", "http://env")).toBe(true);
  });
});
