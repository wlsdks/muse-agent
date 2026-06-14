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
 *  `undefined` if it isn't a well-formed all-hex address. A trailing dotted-IPv4
 *  (`::ffff:1.2.3.4`) returns `undefined` — that form has its own dotted match. */
function expandIPv6Hextets(lower: string): number[] | undefined {
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
  if (hextets && hextets.slice(0, 6).every((h) => h === 0 || h === 0xffff)) {
    const hi = hextets[6] as number;
    const lo = hextets[7] as number;
    if (isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)) return true;
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
 * Validate that `rawUrl` is an http(s) URL whose host resolves only to
 * public addresses. Use BEFORE fetching, and again on the final URL after
 * any redirect (a 3xx Location can point at a private host).
 */
/**
 * The DNS-free half of the guard: protocol + LITERAL loopback/private/link-local
 * IP + blocked hostname. Catches every SSRF vector a model emits as a literal
 * (`http://127.0.0.1`, `http://169.254.169.254`, `file://…`) with no async cost,
 * so a caller that can't await DNS still gets the core protection. The resolved-
 * IP (DNS-rebinding) layer is `assertPublicHttpUrl`.
 */
export function assertPublicHttpUrlSync(rawUrl: string): UrlGuardResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    return { ok: false, error: `invalid URL: ${error instanceof Error ? error.message : String(error)}` };
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
  return { ok: true, url };
}

export async function assertPublicHttpUrl(rawUrl: string, options: { readonly lookup?: HostLookup } = {}): Promise<UrlGuardResult> {
  const sync = assertPublicHttpUrlSync(rawUrl);
  if (!sync.ok) return sync;
  const url = sync.url;
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const lookup = options.lookup ?? defaultLookup;
  try {
    const records = await lookup(hostname);
    if (records.length === 0) {
      return { ok: false, error: `host did not resolve: ${url.hostname}` };
    }
    const privateHit = records.find((r) => isPrivateAddress(r.address));
    if (privateHit) {
      return { ok: false, error: `host resolves to a private address (${privateHit.address}); refusing to read ${url.hostname}` };
    }
  } catch (error) {
    return { ok: false, error: `host did not resolve: ${url.hostname} (${error instanceof Error ? error.message : String(error)})` };
  }
  return { ok: true, url };
}
