import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { parseMcpAccessPolicy, readAdminUrl, swaggerSourcePath } from "./compat-mcp-proxy.js";

// Direct coverage for the pure helpers of the MCP admin proxy (untested module).
// All three are security-relevant: swaggerSourcePath must URL-encode the
// path segment (no path-traversal / query injection), readAdminUrl must accept
// only http(s) (reject javascript:/file: schemes), and parseMcpAccessPolicy
// caps each allowlist at 300 entries (a DoS guard on an admin-supplied policy).

describe("swaggerSourcePath", () => {
  it("URL-encodes the source name so a traversal / query payload can't break the path", () => {
    expect(swaggerSourcePath({ params: { sourceName: "jira" } } as unknown as FastifyRequest)).toBe("/admin/swagger/spec-sources/jira");
    expect(swaggerSourcePath({ params: { sourceName: "../../admin?x=1 y" } } as unknown as FastifyRequest))
      .toBe("/admin/swagger/spec-sources/..%2F..%2Fadmin%3Fx%3D1%20y"); // slashes / ? / space neutralized
  });
});

describe("readAdminUrl", () => {
  it("prefers a valid adminUrl, else falls back to url stripping a trailing /sse", () => {
    expect(readAdminUrl({ adminUrl: "https://a.test/admin", url: "https://b.test" })).toBe("https://a.test/admin");
    expect(readAdminUrl({ url: "https://b.test/sse/" })).toBe("https://b.test");
  });

  it("rejects non-http(s) schemes and missing urls (returns null)", () => {
    expect(readAdminUrl({ url: "javascript:alert(1)" })).toBeNull();
    expect(readAdminUrl({ url: "file:///etc/passwd" })).toBeNull();
    expect(readAdminUrl({})).toBeNull();
  });
});

describe("parseMcpAccessPolicy", () => {
  it("coerces CSV allowlists to deduped sets and keeps only real booleans", () => {
    const result = parseMcpAccessPolicy({ allowedJiraProjectKeys: "A, B ,A", allowPreviewReads: "yes", publishedOnly: true });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({
      allowPreviewReads: null, // a string is NOT a boolean
      allowedJiraProjectKeys: ["A", "B"],
      publishedOnly: true
    });
  });

  it("rejects an allowlist exceeding 300 entries (DoS guard)", () => {
    const tooBig = parseMcpAccessPolicy({ allowedSourceNames: Array.from({ length: 301 }, (_unused, i) => `s${i.toString()}`) });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.ok === false && tooBig.error.code).toBe("INVALID_MCP_ACCESS_POLICY");

    expect(parseMcpAccessPolicy({ allowedSourceNames: Array.from({ length: 300 }, (_unused, i) => `s${i.toString()}`) }).ok).toBe(true);
  });
});
