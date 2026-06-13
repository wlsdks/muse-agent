import { describe, expect, it } from "vitest";

import { assertPublicHttpUrlSync, isPrivateAddress, isPrivateIPv4, isPrivateIPv6 } from "../src/web-url-guard.js";

// Complements web-read.test.ts (which checks representative positives):
// here the focus is the SSRF-critical RANGE BOUNDARIES, where an
// off-by-one lets an internal address through the guard.
describe("isPrivateIPv4 range boundaries", () => {
  it("brackets the 172.16.0.0/12 block exactly", () => {
    expect(isPrivateIPv4("172.15.255.255")).toBe(false);
    expect(isPrivateIPv4("172.16.0.0")).toBe(true);
    expect(isPrivateIPv4("172.31.255.255")).toBe(true);
    expect(isPrivateIPv4("172.32.0.0")).toBe(false);
  });

  it("brackets the 100.64.0.0/10 CGNAT block exactly", () => {
    expect(isPrivateIPv4("100.63.255.255")).toBe(false);
    expect(isPrivateIPv4("100.64.0.0")).toBe(true);
    expect(isPrivateIPv4("100.127.255.255")).toBe(true);
    expect(isPrivateIPv4("100.128.0.0")).toBe(false);
  });

  it("flags this-network 0.0.0.0 and the 192.168/16 edge", () => {
    expect(isPrivateIPv4("0.0.0.0")).toBe(true);
    expect(isPrivateIPv4("192.167.255.255")).toBe(false);
    expect(isPrivateIPv4("192.168.0.1")).toBe(true);
  });

  it("treats public addresses as public and malformed input as not-private", () => {
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("256.1.1.1")).toBe(false); // octet out of range
    expect(isPrivateIPv4("1.2.3")).toBe(false); // too few octets
    expect(isPrivateIPv4("")).toBe(false);
  });
});

describe("isPrivateIPv6 range boundaries", () => {
  it("covers the fe80::/10 link-local span and rejects fec0:: just past it", () => {
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("febf::1")).toBe(true); // top of fe80::/10
    expect(isPrivateIPv6("fec0::1")).toBe(false); // deprecated site-local, outside the /10
  });

  it("covers the fc00::/7 unique-local span", () => {
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fd12:3456::1")).toBe(true);
  });

  it("delegates IPv4-mapped addresses to the v4 classifier", () => {
    expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:8.8.8.8")).toBe(false);
  });

  it("flags the unspecified and loopback addresses, public GUA stays public", () => {
    expect(isPrivateIPv6("::")).toBe(true);
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isPrivateAddress dispatch", () => {
  it("routes colon-bearing strings to the v6 classifier and the rest to v4", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

// The SYNC entry point composes the boundary helpers above into the actual
// SSRF gate callers use (assertPublicHttpUrl is the async DNS-resolving twin,
// covered in web-read.test.ts). The orchestration — protocol, blocked
// hostname, bracket-stripped IPv6, literal loopback — had no direct test, so a
// regression in any single guard clause would pass silently.
describe("assertPublicHttpUrlSync — composed SSRF gate (no DNS)", () => {
  it("rejects a non-http(s) protocol (file://) without a network hop", () => {
    const r = assertPublicHttpUrlSync("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unsupported protocol");
  });
  it("rejects a malformed URL", () => {
    expect(assertPublicHttpUrlSync("not a url").ok).toBe(false);
  });
  it("rejects a blocked hostname (localhost / *.internal)", () => {
    expect(assertPublicHttpUrlSync("http://localhost/admin").ok).toBe(false);
    expect(assertPublicHttpUrlSync("http://metadata.internal/").ok).toBe(false);
  });
  it("rejects a literal loopback IPv4 and a bracketed IPv6 loopback (no DNS lookup)", () => {
    expect(assertPublicHttpUrlSync("http://127.0.0.1:8080/").ok).toBe(false);
    expect(assertPublicHttpUrlSync("http://[::1]/").ok).toBe(false);
    expect(assertPublicHttpUrlSync("http://169.254.169.254/latest/meta-data").ok).toBe(false); // cloud metadata
  });
  it("passes a public https URL and returns the parsed URL", () => {
    const r = assertPublicHttpUrlSync("https://example.com/path");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe("example.com");
  });
});
