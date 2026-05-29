import { describe, expect, it } from "vitest";

import { fetchReadableUrl, type HostLookup } from "../src/index.js";

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
    const res = await fetchReadableUrl("https://example.test/start", {
      fetchImpl: htmlFetch("<p>x</p>", 200, "https://intranet.test/inside"),
      lookup: async (host) => (host === "example.test" ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "10.0.0.5", family: 4 }])
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toMatch(/redirected to a blocked host/u);
  });
});
