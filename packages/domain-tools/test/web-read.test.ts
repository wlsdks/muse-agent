import { describe, expect, it } from "vitest";

import type { JsonObject } from "@muse/shared";

import { assertPublicHttpUrl, createWebReadMcpServer, extractReadableText, isPrivateIPv4, isPrivateIPv6, type HostLookup } from "../src/index.js";

const publicLookup: HostLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function htmlResponse(body: string, init: { status?: number; contentType?: string; url?: string } = {}): Response {
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/html; charset=utf-8" }
  });
  if (init.url) {
    Object.defineProperty(response, "url", { value: init.url });
  }
  return response;
}

async function callRead(server: ReturnType<typeof createWebReadMcpServer>, url: string): Promise<JsonObject> {
  const tool = server.tools.find((t) => t.name === "read");
  if (!tool) throw new Error("read tool missing");
  return (await tool.execute({ url })) as JsonObject;
}

describe("extractReadableText", () => {
  it("strips script/style and tags, decodes entities, and pulls the title", () => {
    const html = [
      "<html><head><title>Hello &amp; Welcome</title>",
      "<style>.x{color:red}</style></head>",
      "<body><script>alert(1)</script>",
      "<h1>Heading</h1><p>First &lt;para&gt;.</p><p>Second line</p></body></html>"
    ].join("");
    const out = extractReadableText(html);
    expect(out.title).toBe("Hello & Welcome");
    expect(out.text).toContain("Heading");
    expect(out.text).toContain("First <para>.");
    expect(out.text).toContain("Second line");
    expect(out.text).not.toContain("alert(1)");
    expect(out.text).not.toContain("color:red");
    expect(out.truncated).toBe(false);
  });

  it("turns block boundaries into line breaks and truncates at maxChars", () => {
    const html = "<p>aaaa</p><p>bbbb</p>";
    const out = extractReadableText(html, { maxChars: 6 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(6);
  });
});

describe("private-address detection", () => {
  it("classifies IPv4 ranges", () => {
    expect(isPrivateIPv4("127.0.0.1")).toBe(true);
    expect(isPrivateIPv4("10.1.2.3")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("192.168.1.1")).toBe(true);
    expect(isPrivateIPv4("169.254.169.254")).toBe(true);
    expect(isPrivateIPv4("93.184.216.34")).toBe(false);
  });

  it("classifies IPv6 loopback / ULA / link-local and mapped v4", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("fd00::1")).toBe(true);
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIPv6("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

describe("assertPublicHttpUrl", () => {
  it("accepts a public http(s) URL", async () => {
    const r = await assertPublicHttpUrl("https://example.com/post", { lookup: publicLookup });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-http protocol", async () => {
    const r = await assertPublicHttpUrl("ftp://example.com/x", { lookup: publicLookup });
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects an IP literal in a private range without needing DNS", async () => {
    const r = await assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/", { lookup: async () => { throw new Error("should not resolve"); } });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/private|loopback/i);
  });

  it("rejects localhost", async () => {
    const r = await assertPublicHttpUrl("http://localhost:8080/admin", { lookup: publicLookup });
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects a public-looking host that RESOLVES to a private address", async () => {
    const r = await assertPublicHttpUrl("http://evil.example.com/", { lookup: async () => [{ address: "10.0.0.5", family: 4 }] });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/private address/i);
  });
});

describe("createWebReadMcpServer.read (contract-faithful fake fetch)", () => {
  it("returns readable text + title for a public html page", async () => {
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      fetch: async () => htmlResponse("<title>Doc</title><body><p>Body text here.</p></body>")
    });
    const out = await callRead(server, "https://example.com/a");
    expect(out.title).toBe("Doc");
    expect(String(out.text)).toContain("Body text here.");
  });

  it("refuses a blocked URL before fetching", async () => {
    let fetched = false;
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      fetch: async () => { fetched = true; return htmlResponse("x"); }
    });
    const out = await callRead(server, "http://127.0.0.1/secret");
    expect(out.error).toBeDefined();
    expect(fetched).toBe(false);
  });

  it("rejects a non-readable content-type", async () => {
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      fetch: async () => new Response("ZIPDATA", { status: 200, headers: { "content-type": "application/zip" } })
    });
    const out = await callRead(server, "https://example.com/archive.zip");
    expect(String(out.error)).toMatch(/not a readable text page/i);
  });

  it("retries a transient 503 then succeeds", async () => {
    let calls = 0;
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      retryOptions: { retries: 2, sleep: async () => {} },
      fetch: async () => {
        calls += 1;
        return calls === 1 ? htmlResponse("busy", { status: 503 }) : htmlResponse("<title>OK</title><p>done</p>");
      }
    });
    const out = await callRead(server, "https://example.com/flaky");
    expect(calls).toBe(2);
    expect(out.title).toBe("OK");
    expect(String(out.text)).toContain("done");
  });

  it("blocks a redirect that lands on a private host", async () => {
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      fetch: async () => htmlResponse("<p>internal</p>", { url: "http://10.0.0.1/internal" })
    });
    const out = await callRead(server, "https://example.com/redir");
    expect(String(out.error)).toMatch(/redirected to a blocked host/i);
  });
});

describe("extractReadableText — strips nav/footer boilerplate (cleaner grounding evidence)", () => {
  it("drops <nav> and <footer> content, keeps the article body", () => {
    const html = [
      "<html><head><title>Article</title></head><body>",
      "<nav><a href='/'>Home</a><a href='/about'>About</a><a href='/contact'>Contact</a></nav>",
      "<article><h1>The Real Headline</h1><p>The substantive article body text.</p></article>",
      "<footer>Copyright 2026 Example Inc. All rights reserved. Privacy Terms.</footer>",
      "</body></html>"
    ].join("");
    const out = extractReadableText(html);
    expect(out.text).toContain("The Real Headline");
    expect(out.text).toContain("substantive article body");
    expect(out.text).not.toContain("About");
    expect(out.text).not.toContain("Contact");
    expect(out.text).not.toContain("All rights reserved");
    expect(out.text).not.toContain("Privacy Terms");
  });
});

describe("createWebReadMcpServer.read — PDF URLs are extracted, not rejected", () => {
  it("reads a PDF response via the injected extractor (content-type application/pdf)", async () => {
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      extractPdfText: async () => "Extracted PDF body about Q3 revenue.",
      fetch: async () => new Response(new Uint8Array(Buffer.from("%PDF-1.7 ...binary...")), { status: 200, headers: { "content-type": "application/pdf" } })
    });
    const out = await callRead(server, "https://files.example.com/report.pdf");
    expect(out.error).toBeUndefined();
    expect(String(out.text)).toContain("Q3 revenue");
  });

  it("still routes a normal HTML page through the text extractor", async () => {
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      extractPdfText: async () => "SHOULD NOT BE USED",
      fetch: async () => htmlResponse("<title>Doc</title><p>html body</p>")
    });
    const out = await callRead(server, "https://example.com/a");
    expect(String(out.text)).toContain("html body");
    expect(String(out.text)).not.toContain("SHOULD NOT BE USED");
  });
});

describe("createWebReadMcpServer.read — image URLs are described via local vision", () => {
  it("reads an image response via the injected vision callback (content-type image/png)", async () => {
    let seenMime = "";
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      describeImage: async (input) => { seenMime = input.mimeType; return { ok: true, text: "A bar chart showing Q3 revenue up 18%." }; },
      fetch: async () => new Response(new Uint8Array(Buffer.from([0x89, 0x50, 0x4e, 0x47])), { status: 200, headers: { "content-type": "image/png" } })
    });
    const out = await callRead(server, "https://files.example.com/chart.png");
    expect(out.error).toBeUndefined();
    expect(String(out.text)).toContain("bar chart");
    expect(seenMime).toBe("image/png");
  });

  it("refuses an image URL when no vision callback is wired", async () => {
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      fetch: async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } })
    });
    const out = await callRead(server, "https://files.example.com/photo.jpg");
    expect(String(out.error)).toMatch(/image|vision|not a readable/i);
  });

  it("still routes HTML through the text extractor when a vision callback is present", async () => {
    const server = createWebReadMcpServer({
      lookup: publicLookup,
      describeImage: async () => ({ ok: true, text: "SHOULD NOT BE USED" }),
      fetch: async () => htmlResponse("<title>Doc</title><p>html body</p>")
    });
    const out = await callRead(server, "https://example.com/a");
    expect(String(out.text)).toContain("html body");
  });
});
