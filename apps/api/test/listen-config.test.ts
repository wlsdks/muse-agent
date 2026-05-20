import { describe, expect, it } from "vitest";

import { resolveListenHost, resolveListenPort } from "../src/listen-config.js";

describe("resolveListenPort", () => {
  it("returns the 3030 fallback when PORT is undefined", () => {
    expect(resolveListenPort(undefined)).toBe(3030);
  });

  it("accepts a clean integer port (trimmed)", () => {
    expect(resolveListenPort("3030")).toBe(3030);
    expect(resolveListenPort("  8080  ")).toBe(8080);
    expect(resolveListenPort("65535")).toBe(65535);
  });

  it("falls back on empty / whitespace / typo / unit-slip / signed / float / out-of-range", () => {
    for (const bad of ["", "   ", "3030x", "30s", "abc", "-1", "0", "3030.5", "1e3", "65536", "100000", "+8080"]) {
      expect(resolveListenPort(bad), `"${bad}" must fall through`).toBe(3030);
    }
  });

  it("honours a custom fallback", () => {
    expect(resolveListenPort(undefined, 8080)).toBe(8080);
    expect(resolveListenPort("not-a-port", 8080)).toBe(8080);
  });
});

describe("resolveListenHost", () => {
  it("returns the 127.0.0.1 fallback when HOST is undefined", () => {
    expect(resolveListenHost(undefined)).toBe("127.0.0.1");
  });

  it("accepts a non-empty trimmed host", () => {
    expect(resolveListenHost("0.0.0.0")).toBe("0.0.0.0");
    expect(resolveListenHost("  ::1  ")).toBe("::1");
    expect(resolveListenHost("api.example.test")).toBe("api.example.test");
  });

  it("treats an empty / whitespace-only HOST as unset (does NOT bind to all interfaces silently)", () => {
    expect(resolveListenHost("")).toBe("127.0.0.1");
    expect(resolveListenHost("   ")).toBe("127.0.0.1");
  });

  it("honours a custom fallback", () => {
    expect(resolveListenHost(undefined, "0.0.0.0")).toBe("0.0.0.0");
    expect(resolveListenHost("", "0.0.0.0")).toBe("0.0.0.0");
  });
});
