import { describe, expect, it } from "vitest";

import { parseDuckDuckGoHtml } from "../src/loopback-search.js";

const block = (href: string, title: string, snippet: string) =>
  `<a rel="nofollow" class="result__a" href="${href}">${title}</a>` +
  `<a class="result__snippet" href="x">${snippet}</a>`;

describe("parseDuckDuckGoHtml", () => {
  it("returns nothing for empty or non-matching HTML", () => {
    expect(parseDuckDuckGoHtml("", 10)).toEqual([]);
    expect(parseDuckDuckGoHtml("<div>no results here</div>", 10)).toEqual([]);
  });

  it("unwraps the DDG redirect (both // and https forms) to the canonical URL", () => {
    expect(parseDuckDuckGoHtml(block("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fx&rut=y", "T", "S"), 10)).toEqual([
      { url: "https://a.com/x", title: "T", snippet: "S" },
    ]);
    expect(parseDuckDuckGoHtml(block("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com", "T", "S"), 10)[0]?.url).toBe(
      "https://b.com",
    );
  });

  it("keeps the href raw when the redirect lacks a query or a uddg param, and passes a non-redirect href through", () => {
    expect(parseDuckDuckGoHtml(block("//duckduckgo.com/l/foo", "T", "S"), 10)[0]?.url).toBe("//duckduckgo.com/l/foo");
    expect(parseDuckDuckGoHtml(block("//duckduckgo.com/l/?rut=z", "T", "S"), 10)[0]?.url).toBe("//duckduckgo.com/l/?rut=z");
    expect(parseDuckDuckGoHtml(block("https://plain.test/p", "T", "S"), 10)[0]?.url).toBe("https://plain.test/p");
  });

  it("decodes HTML entities and strips tags / collapses whitespace in title and snippet", () => {
    expect(parseDuckDuckGoHtml(block("https://e.test", "A &amp; B &quot;C&quot; &#x27;d&#x27; &lt;e&gt;", "s &amp; t"), 10)).toEqual([
      { url: "https://e.test", title: "A & B \"C\" 'd' <e>", snippet: "s & t" },
    ]);
    expect(parseDuckDuckGoHtml(block("https://e.test", "<b>Bold</b>   spaced", "x"), 10)[0]?.title).toBe("Bold spaced");
  });

  it("skips a result whose title is empty after tag stripping", () => {
    expect(parseDuckDuckGoHtml(block("https://e.test", "", "snip"), 10)).toEqual([]);
  });

  it("stops at the max-results cap", () => {
    const html = block("https://1.test", "one", "s1") + block("https://2.test", "two", "s2") + block("https://3.test", "three", "s3");
    const rows = parseDuckDuckGoHtml(html, 2);
    expect(rows.map((r) => r.url)).toEqual(["https://1.test", "https://2.test"]);
  });

  it("does NOT double-decode the uddg target — a literal %20 in the real URL survives intact", () => {
    // DDG percent-encodes the whole target, so a literal `%20` arrives as `%2520`.
    // URLSearchParams.get() already decodes once → `%20`; a second decode would
    // corrupt it to a space and hand the model a broken URL.
    const target = "https://shop.com/p?q=hello%20world";
    const href = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=y`;
    expect(parseDuckDuckGoHtml(block(href, "T", "S"), 10)[0]?.url).toBe(target);
  });

  it("never throws when the decoded target contains a bare percent (URIError otherwise crashes muse.search)", () => {
    const target = "https://sale.com/100%-off";
    const href = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`;
    expect(() => parseDuckDuckGoHtml(block(href, "T", "S"), 10)).not.toThrow();
    expect(parseDuckDuckGoHtml(block(href, "T", "S"), 10)[0]?.url).toBe(target);
  });
});

describe("parseDuckDuckGoHtml — snippet length is capped (tight context for the local model)", () => {
  it("caps a very long snippet but leaves the title and short snippets intact", () => {
    const longSnippet = "word ".repeat(200).trim(); // ~1000 chars
    const [row] = parseDuckDuckGoHtml(block("https://a.test/x", "Short Title", longSnippet), 10);
    expect(row.title).toBe("Short Title");
    expect(row.snippet.length).toBeLessThanOrEqual(300);
    expect(row.snippet.length).toBeGreaterThan(100); // not over-truncated
    const short = parseDuckDuckGoHtml(block("https://b.test/y", "T", "A concise result snippet."), 10)[0];
    expect(short.snippet).toBe("A concise result snippet.");
  });
});
