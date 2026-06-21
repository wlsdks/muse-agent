import { describe, expect, it } from "vitest";

import { normalizeApiBaseUrl } from "./apiUrl.js";

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
