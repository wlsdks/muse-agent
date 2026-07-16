import { describe, expect, it } from "vitest";

import { fetchReadableUrl, isPdfContentType, isReadableContentType, type HostLookup } from "../src/index.js";

const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup: HostLookup = async () => [{ address: "10.0.0.5", family: 4 }];
const noWait = { baseDelayMs: 0, sleep: async () => {} };

function htmlFetch(body: string, status = 200, finalUrl?: string) {
  return (async () => {
    const r = new Response(body, { status, headers: { "content-type": "text/html" } });
    if (finalUrl) Object.defineProperty(r, "url", { value: finalUrl });
    return r;
  }) as unknown as typeof globalThis.fetch;
}

function typedFetch(body: string, contentType: string) {
  return (async () => new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof globalThis.fetch;
}

describe("fetchReadableUrl", () => {
  it("returns readable text + title for a public page", async () => {
    const res = await fetchReadableUrl("https://example.test/post", {
      fetchImpl: htmlFetch("<html><head><title>Hello</title></head><body><p>Real content here.</p></body></html>"),
      lookup: publicLookup
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("Real content here.");
      expect(res.title).toBe("Hello");
    }
  });

  it("refuses a host that resolves to a private address (SSRF guard)", async () => {
    const res = await fetchReadableUrl("https://intranet.test/secret", {
      fetchImpl: htmlFetch("nope"),
      lookup: privateLookup
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/private address/u);
  });

  it("refuses a non-http(s) protocol", async () => {
    const res = await fetchReadableUrl("ftp://example.test/x", { lookup: publicLookup });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/unsupported protocol/u);
  });

  it("preserves initial guard surfaces and does no fetch for literal, DNS-private, or DNS-unresolved inputs", async () => {
    let fetches = 0;
    const fetchImpl = (async () => { fetches += 1; return new Response("unexpected"); }) as typeof globalThis.fetch;
    const literal = await fetchReadableUrl("http://127.0.0.1/private", { fetchImpl, lookup: publicLookup });
    const dnsPrivate = await fetchReadableUrl("https://private-name.test/x", { fetchImpl, lookup: privateLookup });
    const dnsUnresolved = await fetchReadableUrl("https://missing-name.test/x", { fetchImpl, lookup: async () => { throw new Error("NXDOMAIN"); } });
    expect(literal).toMatchObject({ ok: false });
    expect(dnsPrivate).toMatchObject({ ok: false });
    expect(dnsUnresolved).toMatchObject({ ok: false });
    if (!literal.ok) expect(literal.error).toBe("refusing to read a private/loopback address: 127.0.0.1");
    if (!dnsPrivate.ok) expect(dnsPrivate.error).toMatch(/host resolves to a private address/u);
    if (!dnsUnresolved.ok) expect(dnsUnresolved.error).toMatch(/host did not resolve/u);
    expect(fetches).toBe(0);
  });

  it("surfaces a permanent HTTP error without retrying it forever", async () => {
    const res = await fetchReadableUrl("https://example.test/missing", {
      fetchImpl: htmlFetch("", 404),
      lookup: publicLookup,
      retryOptions: noWait
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/HTTP 404/u);
  });

  it("refuses a redirect that lands on a private host", async () => {
    const requests: string[] = [];
    const res = await fetchReadableUrl("https://example.test/start", {
      fetchImpl: (async (url) => {
        requests.push(String(url));
        return new Response("redirect body must stay unread", { status: 302, headers: { location: "https://intranet.test/inside" } });
      }) as typeof globalThis.fetch,
      lookup: async (host) => (host === "example.test" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.5", family: 4 }])
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/redirected to a blocked host/u);
    expect(requests).toEqual(["https://example.test/start"]);
  });

  it("uses the redirect state machine finalUrl rather than a hostile response.url", async () => {
    let calls = 0;
    const res = await fetchReadableUrl("https://example.test/start", {
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return new Response("redirect", { status: 302, headers: { location: "/final" } });
        const final = new Response("<title>Final</title><p>trusted final body</p>", { status: 200, headers: { "content-type": "text/html" } });
        Object.defineProperty(final, "url", { value: "https://attacker.test/wrong" });
        return final;
      }) as typeof globalThis.fetch,
      lookup: publicLookup,
      retryOptions: noWait
    });
    expect(res).toMatchObject({ finalUrl: "https://example.test/final", ok: true });
  });

  it("refuses a non-text resource by content-type (a PDF URL is not grounded on)", async () => {
    const res = await fetchReadableUrl("https://example.test/report.pdf", {
      fetchImpl: typedFetch("%PDF-1.7 ...binary...", "application/pdf"),
      lookup: publicLookup
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/not a readable text page.*application\/pdf/u);
  });

  it("READS a PDF URL when a pdfExtractor is wired (online PDF grounding)", async () => {
    const res = await fetchReadableUrl("https://example.test/policy.pdf", {
      fetchImpl: typedFetch("%PDF-1.7 ...binary bytes...", "application/pdf"),
      lookup: publicLookup,
      retryOptions: noWait,
      pdfExtractor: async (bytes) => `decoded ${bytes.length.toString()} bytes — annual premium 840,000 KRW, renews 2026-09-14`
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("annual premium 840,000 KRW");
      expect(res.finalUrl).toBe("https://example.test/policy.pdf");
    }
  });

  it("refuses a PDF whose extractor yields no text (scanned / image-only — never grounds on empty)", async () => {
    const res = await fetchReadableUrl("https://example.test/scan.pdf", {
      fetchImpl: typedFetch("%PDF...", "application/pdf"),
      lookup: publicLookup,
      retryOptions: noWait,
      pdfExtractor: async () => "   "
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no extractable text/u);
  });

  it("surfaces a PDF extractor failure as a clear error (not a crash)", async () => {
    const res = await fetchReadableUrl("https://example.test/corrupt.pdf", {
      fetchImpl: typedFetch("not really a pdf", "application/pdf"),
      lookup: publicLookup,
      retryOptions: noWait,
      pdfExtractor: async () => { throw new Error("invalid PDF structure"); }
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/PDF could not be read.*invalid PDF structure/u);
  });

  it("refuses an image content-type", async () => {
    const res = await fetchReadableUrl("https://example.test/photo.png", {
      fetchImpl: typedFetch("\x00\x00binary", "image/png"),
      lookup: publicLookup
    });
    expect(res).toMatchObject({ ok: false });
  });

  it("grounds on a JSON / plain-text response (text content-types are allowed)", async () => {
    const json = await fetchReadableUrl("https://api.example.test/data", {
      fetchImpl: typedFetch('{"answer":"forty-two is the value"}', "application/json; charset=utf-8"),
      lookup: publicLookup
    });
    expect(json.ok).toBe(true);
    if (json.ok) expect(json.text).toContain("forty-two");
  });

  it("backstops a binary body served WITH a text content-type (NUL-byte sniff)", async () => {
    const res = await fetchReadableUrl("https://example.test/mislabeled", {
      fetchImpl: typedFetch("\x00\x00\x00\x00PK\x03\x04 binary zip bytes", "text/html"),
      lookup: publicLookup
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/binary content/u);
  });

  it("refuses a body that exceeds the byte limit before text extraction", async () => {
    const res = await fetchReadableUrl("https://example.test/large", {
      fetchImpl: htmlFetch("x".repeat(128)),
      lookup: publicLookup,
      maxResponseBytes: 64
    });

    expect(res).toEqual({ error: "response body exceeds 64 byte limit", ok: false });
  });

  it("does not pass an oversized PDF body to the extractor", async () => {
    let extractorCalled = false;
    const res = await fetchReadableUrl("https://example.test/large.pdf", {
      fetchImpl: typedFetch("x".repeat(128), "application/pdf"),
      lookup: publicLookup,
      maxResponseBytes: 64,
      pdfExtractor: async () => {
        extractorCalled = true;
        return "must not run";
      }
    });

    expect(res).toEqual({ error: "response body exceeds 64 byte limit", ok: false });
    expect(extractorCalled).toBe(false);
  });

  it("ignores invalid text limits instead of handing a negative or fractional slice length to PDF or HTML readers", async () => {
    const html = await fetchReadableUrl("https://example.test/article", {
      fetchImpl: htmlFetch("<p>full readable article</p>"),
      lookup: publicLookup,
      maxChars: -1
    });
    const pdf = await fetchReadableUrl("https://example.test/article.pdf", {
      fetchImpl: typedFetch("%PDF", "application/pdf"),
      lookup: publicLookup,
      maxChars: 0.5,
      pdfExtractor: async () => "full PDF text"
    });

    expect(html).toMatchObject({ ok: true, text: "full readable article", truncated: false });
    expect(pdf).toMatchObject({ ok: true, text: "full PDF text", truncated: false });
  });
});

describe("isPdfContentType", () => {
  it("matches application/pdf (with params) and x-pdf, not html/text", () => {
    expect(isPdfContentType("application/pdf")).toBe(true);
    expect(isPdfContentType("application/pdf; charset=binary")).toBe(true);
    expect(isPdfContentType("application/x-pdf")).toBe(true);
    expect(isPdfContentType("text/html")).toBe(false);
    expect(isPdfContentType("application/json")).toBe(false);
  });
});

describe("isReadableContentType", () => {
  it("allows text / html / xml / json (and treats a missing type as deferred=true)", () => {
    for (const ct of ["text/html", "text/plain; charset=utf-8", "application/xhtml+xml", "application/json", "application/rss+xml", "application/atom+xml", ""]) {
      expect(isReadableContentType(ct), ct).toBe(true);
    }
  });

  it("refuses binary types", () => {
    for (const ct of ["application/pdf", "image/png", "image/jpeg", "application/octet-stream", "audio/mpeg", "video/mp4", "application/zip", "font/woff2"]) {
      expect(isReadableContentType(ct), ct).toBe(false);
    }
  });
});
