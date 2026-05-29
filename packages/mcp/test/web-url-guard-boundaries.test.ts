import { describe, expect, it } from "vitest";

import { isPrivateAddress, isPrivateIPv4, isPrivateIPv6 } from "../src/web-url-guard.js";

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
