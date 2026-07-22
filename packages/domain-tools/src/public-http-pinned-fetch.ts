/**
 * The SSRF fix that the preflight guard cannot provide alone.
 *
 * `assertPublicHttpUrl` resolves the hostname and classifies the IP, then hands
 * the bare HOSTNAME to fetch — which re-resolves independently when it opens the
 * socket. A rebinding DNS server answers the guard's query with a public IP
 * (passes) and the connection query with `127.0.0.1` / `169.254.169.254` /
 * RFC-1918 (connects). This closes that window by validating the address AT
 * CONNECT TIME: undici's `connect.lookup` is the exact resolution the socket
 * uses, so a non-public result is refused before any byte is sent — there is no
 * second, unvalidated resolution left to differ.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";

import { Agent, fetch as undiciFetch } from "undici";

import { isNonPublicWebAddress } from "./web-url-guard.js";

/**
 * A `net.LookupFunction` that resolves normally, then refuses if ANY returned
 * address is non-public. Because undici calls this at socket-connect time with
 * the address it is about to use, validating here removes the check-then-connect
 * gap the preflight guard leaves open. Typed loosely (undici's connect.lookup
 * expects the node net LookupFunction shape) and validated at runtime.
 */
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * The connect-time gate: given the addresses the socket is about to use, return
 * the first non-public one, or null if all are public. Exported for testing —
 * this is the check that closes the rebinding window, so it is worth pinning
 * directly rather than only through a live DNS round-trip.
 */
export function firstNonPublicAddress(records: readonly LookupAddress[]): string | null {
  return records.find((record) => isNonPublicWebAddress(record.address))?.address ?? null;
}

function validatingLookup(hostname: string, _options: unknown, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    const records: LookupAddress[] = Array.isArray(addresses) ? addresses : [];
    const blocked = firstNonPublicAddress(records);
    if (blocked !== null) {
      callback(new Error(`refusing to connect to non-public address ${blocked} for ${hostname}`) as NodeJS.ErrnoException, "", 0);
      return;
    }
    callback(null, records);
  });
}

// One shared dispatcher: the lookup is stateless, and reusing it keeps
// connection pooling. `connect.lookup` runs on every new connection, including
// each redirect hop's fresh fetch. Cast: undici's connect options type the
// lookup as the node net LookupFunction, which this matches at runtime.
const pinnedAgent = new Agent({ connect: { lookup: validatingLookup as never } });

/**
 * A `fetch` that connects only to public addresses, validated at the moment the
 * socket resolves. Drop-in for `globalThis.fetch` on the guarded public-web
 * paths; the preflight `assertPublicHttpUrl` still runs ahead of it for the
 * synchronous literal-IP / blocked-hostname / scheme checks and per-hop redirect
 * target classification.
 */
export const pinnedPublicFetch: typeof globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...(init as Parameters<typeof undiciFetch>[1]), dispatcher: pinnedAgent }) as unknown as Promise<Response>) as typeof globalThis.fetch;
