import { describe, expect, it } from "vitest";

import { extractImageSources, resolveImageAttachmentCandidates } from "../src/index.js";

describe("extractImageSources (MED-12)", () => {
  it("extracts image URLs and excludes non-image URLs", () => {
    const r = extractImageSources("look at https://cdn.example.com/a.png and https://example.com/page");
    expect(r.urls).toEqual(["https://cdn.example.com/a.png"]);
  });

  it("keeps an image URL with a query string", () => {
    expect(extractImageSources("https://cdn.example.com/a.jpg?w=200").urls).toEqual(["https://cdn.example.com/a.jpg?w=200"]);
  });

  it("drops an SSRF/loopback image URL (composes the SSRF guard)", () => {
    expect(extractImageSources("http://169.254.169.254/x.png and http://localhost/y.png").urls).toEqual([]);
  });

  it("extracts path-shaped local image refs (~/, ./, ../, /abs)", () => {
    const r = extractImageSources("try ~/pics/a.png or ./img/b.jpeg or ../c.gif or /abs/d.webp");
    expect(r.paths).toEqual(["~/pics/a.png", "./img/b.jpeg", "../c.gif", "/abs/d.webp"]);
  });

  it("does NOT treat a bare filename in prose as a path", () => {
    expect(extractImageSources("the file config.png describes it").paths).toEqual([]);
  });

  it("de-duplicates and returns empty arrays when there are no image sources", () => {
    expect(extractImageSources("/x/a.png and again /x/a.png").paths).toEqual(["/x/a.png"]);
    expect(extractImageSources("no images here")).toEqual({ paths: [], urls: [] });
  });
});

describe("resolveImageAttachmentCandidates", () => {
  const text = "attach ~/safe/a.png and /sensitive/b.png and /missing/c.png";

  it("keeps only paths that are BOTH safe and existing", () => {
    const out = resolveImageAttachmentCandidates(text, {
      isPathSafe: (p) => !p.includes("/sensitive/"),
      fileExists: (p) => !p.includes("/missing/")
    });
    expect(out).toEqual(["~/safe/a.png"]);
  });

  it("drops everything when the safety gate rejects all", () => {
    expect(resolveImageAttachmentCandidates(text, { isPathSafe: () => false, fileExists: () => true })).toEqual([]);
  });

  it("drops everything when nothing exists", () => {
    expect(resolveImageAttachmentCandidates(text, { isPathSafe: () => true, fileExists: () => false })).toEqual([]);
  });
});
