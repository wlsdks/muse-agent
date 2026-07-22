/**
 * The SSRF preflight guard resolves the hostname and validates the IP, then
 * hands the bare hostname to fetch, which re-resolves independently at connect
 * time — a rebinding DNS server answers the guard with a public IP and the
 * connection with `127.0.0.1` / `169.254.169.254` / RFC-1918. The fix validates
 * the address AT CONNECT TIME, where undici's `connect.lookup` runs with the
 * exact address the socket will use, so there is no second unvalidated
 * resolution left to differ.
 *
 * `firstNonPublicAddress` is that connect-time gate. Live proof that the wiring
 * fires end-to-end: `pinnedPublicFetch('http://localtest.me/')` — a public DNS
 * name that resolves to 127.0.0.1 — is refused with "refusing to connect to
 * non-public address 127.0.0.1" (kept out of the offline suite because it needs
 * DNS).
 */

import { describe, expect, it } from "vitest";

import { firstNonPublicAddress } from "../src/public-http-pinned-fetch.js";

describe("connect-time address gate (closes the DNS-rebinding TOCTOU)", () => {
  it("refuses a resolution set containing a loopback / metadata / private address", () => {
    // These are exactly what a rebinding server flips to AFTER the preflight
    // passed on a public IP — the connect-time gate must catch each.
    expect(firstNonPublicAddress([{ address: "127.0.0.1", family: 4 }])).toBe("127.0.0.1");
    expect(firstNonPublicAddress([{ address: "169.254.169.254", family: 4 }])).toBe("169.254.169.254");
    expect(firstNonPublicAddress([{ address: "10.0.0.5", family: 4 }])).toBe("10.0.0.5");
    expect(firstNonPublicAddress([{ address: "192.168.1.1", family: 4 }])).toBe("192.168.1.1");
    expect(firstNonPublicAddress([{ address: "::1", family: 6 }])).toBe("::1");
  });

  it("catches a private address hiding among public ones (multi-record rebind)", () => {
    // A resolver returning both a public and a private record must still be
    // refused — the socket could connect to either.
    expect(firstNonPublicAddress([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ])).toBe("127.0.0.1");
  });

  it("allows an all-public resolution set", () => {
    expect(firstNonPublicAddress([{ address: "93.184.216.34", family: 4 }])).toBeNull();
    expect(firstNonPublicAddress([
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 }
    ])).toBeNull();
  });
});
