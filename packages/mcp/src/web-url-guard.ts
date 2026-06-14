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

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/gu, "");
  if (lower === "::1" || lower === "::") return true;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1] as string);
  // WHATWG `new URL()` compresses an IPv4-mapped IPv6 host to hex (`::ffff:127.0.0.1`
  // → `::ffff:7f00:1`), so the dotted match above never fires for a real URL.
  // Decode the two hex groups back to octets and classify — else loopback /
  // cloud-metadata / RFC-1918 slip through this guard as "public" (SSRF).
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(lower);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1] as string, 16);
    const lo = Number.parseInt(hexMapped[2] as string, 16);
    return isPrivateIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
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
