import { describe, expect, it } from "vitest";

import { defaultApiBaseUrl, normalizeApiBaseUrl } from "./apiUrl.js";

describe("defaultApiBaseUrl", () => {
  it("uses the page origin for a production http(s) page — every host alias satisfies CSP 'self'", () => {
    expect(defaultApiBaseUrl({ protocol: "http:", origin: "http://localhost:3030" }, false)).toBe(
      "http://localhost:3030"
    );
    expect(defaultApiBaseUrl({ protocol: "http:", origin: "http://127.0.0.1:3030" }, false)).toBe(
      "http://127.0.0.1:3030"
    );
    expect(defaultApiBaseUrl({ protocol: "https:", origin: "https://muse.lan" }, false)).toBe("https://muse.lan");
  });

  it("keeps the loopback default on the vite dev server — its origin is not the API", () => {
    expect(defaultApiBaseUrl({ protocol: "http:", origin: "http://localhost:5173" }, true)).toBe(
      "http://127.0.0.1:3030"
    );
  });

  it("keeps the loopback default for non-http pages (file:// shells)", () => {
    expect(defaultApiBaseUrl({ protocol: "file:", origin: "null" }, false)).toBe("http://127.0.0.1:3030");
  });

  it("keeps the loopback default when no window exists (static render)", () => {
    expect(defaultApiBaseUrl(undefined, false)).toBe("http://127.0.0.1:3030");
  });
});

describe("normalizeApiBaseUrl", () => {
  it("adds a default http:// scheme when missing", () => {
    expect(normalizeApiBaseUrl("127.0.0.1:3030")).toEqual({ url: "http://127.0.0.1:3030", valid: true });
    expect(normalizeApiBaseUrl("localhost:3030")).toEqual({ url: "http://localhost:3030", valid: true });
  });

  it("keeps an explicit https scheme", () => {
    expect(normalizeApiBaseUrl("https://muse.example.com")).toEqual({ url: "https://muse.example.com", valid: true });
  });

  it("strips a trailing slash", () => {
    expect(normalizeApiBaseUrl("http://127.0.0.1:3030/")).toEqual({ url: "http://127.0.0.1:3030", valid: true });
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeApiBaseUrl("  http://x:3030  ")).toEqual({ url: "http://x:3030", valid: true });
  });

  it("rejects an empty or whitespace-only input", () => {
    expect(normalizeApiBaseUrl("")).toEqual({ url: "", valid: false });
    expect(normalizeApiBaseUrl("   ")).toEqual({ url: "", valid: false });
  });

  it("rejects a non-http scheme", () => {
    expect(normalizeApiBaseUrl("ftp://host").valid).toBe(false);
    expect(normalizeApiBaseUrl("file:///etc/passwd").valid).toBe(false);
  });

  it("rejects hostless garbage", () => {
    expect(normalizeApiBaseUrl("http://").valid).toBe(false);
    expect(normalizeApiBaseUrl("://nope").valid).toBe(false);
  });
});
