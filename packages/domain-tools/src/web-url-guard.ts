import { errorMessage } from "@muse/shared";
/**
 * SSRF guard for reading user-named public web URLs (`muse.web.read`).
 *
 * `muse.fetch` protects itself with an exact-host allowlist, but a read
 * tool that takes ANY URL the user (or a page Muse already read) names
 * needs the opposite shape: allow the public web, deny everything that
 * could reach the loopback machine or a private network. The danger is a
 * prompt-injected page steering Muse at `http://169.254.169.254/…` (cloud
 * metadata) or an internal service. We block by resolved IP, not just by
 * the literal hostname, so `evil.example` → `127.0.0.1` is caught too.
 */

import { lookup as dnsLookup } from "node:dns/promises";

export type HostLookup = (hostname: string) => Promise<readonly { readonly address: string; readonly family: number }[]>;

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true });

export type UrlGuardResult = { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly error: string };

function ipv4ToParts(ip: string): readonly number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/u.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return undefined;
  return nums;
}

function ipv4MatchesCidr(ip: string, network: string, prefixBits: number): boolean {
  const address = ipv4ToParts(ip);
  const base = ipv4ToParts(network);
  if (!address || !base) return false;
  const value = address[0]! * 0x1000000 + address[1]! * 0x10000 + address[2]! * 0x100 + address[3]!;
  const networkValue = base[0]! * 0x1000000 + base[1]! * 0x10000 + base[2]! * 0x100 + base[3]!;
  const block = 2 ** (32 - prefixBits);
  return Math.floor(value / block) === Math.floor(networkValue / block);
}

/**
 * Bounded public-web address policy, reviewed against the IANA IPv4/IPv6
 * Special-Purpose registries and RFC 4291 on 2026-07-13. This is intentionally
 * a code-owned table: unlisted normal global-unicast addresses remain allowed;
 * it is not a vague "special means blocked" fallback.
 */
export const PUBLIC_WEB_ADDRESS_POLICY_REVIEWED_AT = "2026-07-13";

const IPV4_NON_PUBLIC_CIDRS: readonly (readonly [network: string, prefixBits: number])[] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];

// More-specific IANA globally-reachable allocations win over the false/N/A
// 192.0.0.0/24 parent. The separate audit rows are intentionally represented
// in code and tests even though default global-unicast handling would allow them.
const IPV4_EXPLICIT_PUBLIC_CIDRS: readonly (readonly [network: string, prefixBits: number])[] = [
  ["192.0.0.9", 32], ["192.0.0.10", 32], ["192.31.196.0", 24],
  ["192.52.193.0", 24], ["192.175.48.0", 24]
];

function isNonPublicWebIPv4(ip: string): boolean {
  if (!ipv4ToParts(ip)) return false;
  if (IPV4_EXPLICIT_PUBLIC_CIDRS.some(([network, prefixBits]) => ipv4MatchesCidr(ip, network, prefixBits))) return false;
  return IPV4_NON_PUBLIC_CIDRS.some(([network, prefixBits]) => ipv4MatchesCidr(ip, network, prefixBits));
}

export function isPrivateIPv4(ip: string): boolean {
  const p = ipv4ToParts(ip);
  if (!p) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Expand an IPv6 textual form (with `::` compression) into its 8 hextets, or
 *  `undefined` if it is malformed. A trailing dotted IPv4 tail is normalized
 *  first so RFC 4291 mapped/compatible forms share the same classifier. */
function expandIPv6Hextets(lower: string): number[] | undefined {
  // URL.hostname normally emits the hexadecimal form, but direct callers and
  // DNS fixtures may use an RFC 4291 dotted IPv4 tail. Normalize it before the
  // ordinary 8-hextet parser so mapped/compatible/SIIT policy is exact.
  const dottedTail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(lower);
  if (dottedTail) {
    const dotted = ipv4ToParts(dottedTail[2]!);
    if (!dotted) return undefined;
    lower = `${dottedTail[1]!}${((dotted[0]! << 8) | dotted[1]!).toString(16)}:${((dotted[2]! << 8) | dotted[3]!).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/u.test(lower) || (lower.match(/::/gu) ?? []).length > 1) return undefined;
  const parse = (s: string): number[] => (s === "" ? [] : s.split(":").map((g) => Number.parseInt(g, 16)));
  let groups: number[];
  if (lower.includes("::")) {
    const [left, right] = lower.split("::");
    const head = parse(left as string);
    const tail = parse(right as string);
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = parse(lower);
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

function ipv6MatchesCidr(hextets: readonly number[], network: string, prefixBits: number): boolean {
  const base = expandIPv6Hextets(network);
  if (!base || hextets.length !== 8) return false;
  let remaining = prefixBits;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const bits = Math.min(16, remaining);
    const shift = 16 - bits;
    if ((hextets[index]! >> shift) !== (base[index]! >> shift)) return false;
    remaining -= bits;
  }
  return true;
}

const IPV6_NON_PUBLIC_CIDRS: readonly (readonly [network: string, prefixBits: number])[] = [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["100:0:0:1::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
];

const IPV6_EXPLICIT_PUBLIC_CIDRS: readonly (readonly [network: string, prefixBits: number])[] = [
  ["2001:1::1", 128], ["2001:1::2", 128], ["2001:1::3", 128], ["2001:3::", 32],
  ["2001:4:112::", 48], ["2001:20::", 28], ["2001:30::", 28], ["2620:4f:8000::", 48]
];

/**
 * Return true only for a bounded set of address-space destinations that are not
 * safe public-web targets. DNS resolution here is preflight-only: it does not
 * pin the later socket connection and must not be described as DNS-rebinding
 * resistant transport protection.
 */
export function isNonPublicWebAddress(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!normalized.includes(":")) return isNonPublicWebIPv4(normalized);
  const hextets = expandIPv6Hextets(normalized);
  if (!hextets) return false;

  // IANA true allocations more specific than 2001::/23 are checked before
  // their false/N/A parent (longest-prefix-first policy).
  if (IPV6_EXPLICIT_PUBLIC_CIDRS.some(([network, prefixBits]) => ipv6MatchesCidr(hextets, network, prefixBits))) return false;

  // These three legacy forms are intentionally denied regardless of whether
  // their low 32 bits happen to look globally routable.
  const compatible = hextets.slice(0, 6).every((part) => part === 0);
  const mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  const siit = hextets.slice(0, 4).every((part) => part === 0) && hextets[4] === 0xffff && hextets[5] === 0;
  if (compatible || mapped || siit) return true;

  // RFC 6052 well-known NAT64 maps only this exact /96 form. Its embedded
  // IPv4 inherits the same bounded table; no 6to4/other translation inference.
  const wellKnownNat64 = hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((part) => part === 0);
  if (wellKnownNat64) {
    const high = hextets[6]!;
    const low = hextets[7]!;
    return isNonPublicWebIPv4(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
  }

  return IPV6_NON_PUBLIC_CIDRS.some(([network, prefixBits]) => ipv6MatchesCidr(hextets, network, prefixBits));
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/gu, "");
  if (lower === "::1" || lower === "::") return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1] as string);
  // Any IPv4-EMBEDDING form — IPv4-mapped (`::ffff:7f00:1`), IPv4-compatible
  // (`::7f00:1`, the deprecated `::127.0.0.1` Node compresses to hex), and SIIT
  // (`::ffff:0:7f00:1`) — carries the IPv4 in its low 32 bits with the upper 96
  // bits all 0x0000/0xffff. WHATWG `new URL()` emits exactly these for a bracketed
  // host, so loopback / cloud-metadata (`::a9fe:a9fe`) / RFC-1918 would otherwise
  // slip through as "public". Decode the embedded IPv4 and classify it.
  const hextets = expandIPv6Hextets(lower);
  if (hextets) {
    // IPv4-embedding upper-96-bit prefixes whose low 32 bits carry the IPv4:
    // mapped/compatible/SIIT (all 0x0000/0xffff) AND the NAT64 well-known prefix
    // 64:ff9b::/96 (RFC 6052), which a NAT64 gateway translates to the embedded
    // IPv4 — so `64:ff9b::<private>` reaches that private host too.
    const upperEmbeds = hextets.slice(0, 6).every((h) => h === 0 || h === 0xffff);
    const isNat64 = hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((h) => h === 0);
    if (upperEmbeds || isNat64) {
      const hi = hextets[6] as number;
      const lo = hextets[7] as number;
      if (isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)) return true;
    }
  }
  if (/^fe[89ab][0-9a-f]:/u.test(lower)) return true;
  if (/^f[cd][0-9a-f]{2}:/u.test(lower)) return true;
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  return ip.includes(":") ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/u, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

/**
 * Validate that `rawUrl` is an http(s) URL whose host resolves only to bounded
 * public-web addresses. Use immediately before each physical fetch. This is a
 * DNS preflight check only, not socket pinning or a full DNS-rebinding defence.
 */
/**
 * The DNS-free half of the guard: protocol + LITERAL loopback/private/link-local
 * IP + blocked hostname. Catches every SSRF vector a model emits as a literal
 * (`http://127.0.0.1`, `http://169.254.169.254`, `file://…`) with no async cost,
 * so a caller that can't await DNS still gets the core protection. The resolved
 * IP layer in `assertPublicHttpUrl` is still only preflight, not connection pinning.
 */
export function assertPublicHttpUrlSync(rawUrl: string): UrlGuardResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: `invalid URL: 'url' must be an absolute http(s) URL including the scheme, e.g. 'https://example.com/article' (got ${JSON.stringify(rawUrl)})`,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `unsupported protocol '${url.protocol}' — only http(s) is allowed` };
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (isBlockedHostname(hostname)) {
    return { ok: false, error: `refusing to read a local/internal host: ${url.hostname}` };
  }
  if ((url.hostname.includes(":") || ipv4ToParts(hostname)) && isPrivateAddress(hostname)) {
    return { ok: false, error: `refusing to read a private/loopback address: ${url.hostname}` };
  }
  if ((url.hostname.includes(":") || ipv4ToParts(hostname)) && isNonPublicWebAddress(hostname)) {
    return { ok: false, error: `refusing to read a non-public web address: ${url.hostname}` };
  }
  return { ok: true, url };
}

const URL_CANDIDATE_RE = /https?:\/\/[^\s<>"'`)\]]+/giu;

/**
 * Extract the SSRF-SAFE public http(s) URLs from freeform text (a user
 * message, a fetched page). Finds bare URLs — markdown-link targets too,
 * since the pattern stops at the closing paren/bracket — strips trailing
 * sentence punctuation, de-duplicates preserving first-seen order, and
 * keeps ONLY those that pass {@link assertPublicHttpUrlSync}. A
 * private/loopback/non-http lure (e.g. an injected
 * `http://169.254.169.254/…` cloud-metadata link) is dropped. Pure +
 * synchronous (no DNS) — defense-in-depth for any path that would act on a
 * URL found in untrusted text.
 */
export function extractPublicHttpUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_CANDIDATE_RE)) {
    const candidate = match[0].replace(/[.,;:!?]+$/u, "");
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (assertPublicHttpUrlSync(candidate).ok) {
      out.push(candidate);
    }
  }
  return out;
}

export async function assertPublicHttpUrl(rawUrl: string, options: { readonly lookup?: HostLookup } = {}): Promise<UrlGuardResult> {
  const sync = assertPublicHttpUrlSync(rawUrl);
  if (!sync.ok) return sync;
  const url = sync.url;
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  // A literal address has no DNS rebinding surface. The synchronous half has
  // already classified every IPv4/IPv6 non-public range, so asking the OS
  // resolver to "look up" a public literal only adds an offline/hung-DNS
  // failure mode and can stall otherwise deterministic guarded fetches.
  if (ipv4ToParts(hostname) || hostname.includes(":")) return { ok: true, url };
  const lookup = options.lookup ?? defaultLookup;
  try {
    const records = await lookup(hostname);
    if (records.length === 0) {
      return { ok: false, error: `host did not resolve: ${url.hostname}` };
    }
    const nonPublicHit = records.find((r) => isNonPublicWebAddress(r.address));
    if (nonPublicHit) {
      if (isPrivateAddress(nonPublicHit.address)) {
        return { ok: false, error: `host resolves to a private address (${nonPublicHit.address}); refusing to read ${url.hostname}` };
      }
      return { ok: false, error: `host resolves to a non-public web address (${nonPublicHit.address}); refusing to read ${url.hostname}` };
    }
  } catch (error) {
    return { ok: false, error: `host did not resolve: ${url.hostname} (${errorMessage(error)})` };
  }
  return { ok: true, url };
}
