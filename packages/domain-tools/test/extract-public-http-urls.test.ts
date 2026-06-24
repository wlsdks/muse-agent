import { describe, expect, it } from "vitest";

import { extractPublicHttpUrls } from "../src/index.js";

describe("extractPublicHttpUrls (WEB-5)", () => {
  it("extracts a bare URL from prose and strips trailing punctuation", () => {
    expect(extractPublicHttpUrls("see https://example.com/page. thanks")).toEqual(["https://example.com/page"]);
  });

  it("extracts a markdown-link target", () => {
    expect(extractPublicHttpUrls("read [the docs](https://example.com/docs) now")).toEqual(["https://example.com/docs"]);
  });

  it("drops SSRF / private / loopback / metadata lures", () => {
    const text = "ok https://good.example.com but not http://169.254.169.254/latest/meta or http://localhost:8080/x or http://127.0.0.1";
    expect(extractPublicHttpUrls(text)).toEqual(["https://good.example.com"]);
  });

  it("drops non-http(s) schemes", () => {
    expect(extractPublicHttpUrls("ftp://example.com/x and file:///etc/passwd and https://ok.example.com")).toEqual(["https://ok.example.com"]);
  });

  it("de-duplicates preserving first-seen order", () => {
    expect(extractPublicHttpUrls("https://a.example.com then https://b.example.com then https://a.example.com"))
      .toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("returns [] when there is no URL", () => {
    expect(extractPublicHttpUrls("just some text, no links here")).toEqual([]);
  });
});
