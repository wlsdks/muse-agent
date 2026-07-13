/**
 * Egress authorization — provenance-gated, not secret-matching. An http(s)/ws(s)
 * URL leaving the box must be QUOTED: present verbatim in something the user
 * typed, something in the user's own stores (notes/memory/calendar — the
 * assembled system/context blocks), or a page/tool-result Muse actually read
 * this run. A URL the MODEL composed itself is denied outright. This is
 * immune to base64 / percent-encoding / homoglyph / chunked payload tricks —
 * an encoded payload is still a composed (never-observed) URL, so no
 * secret-corpus lookup is needed or attempted.
 *
 * Lives in `@muse/tools` (not `agent-core`) so both `agent-core` and the
 * browser/domain-tools packages can share ONE authority without inverting the
 * package layering. Pure: no I/O, no knowledge of tool names/risk — the
 * caller (agent-core, which already classifies first-party vs third-party
 * tools) decides which bucket a piece of text belongs in.
 */

const SUPPORTED_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * CamoLeak-dictionary control (arXiv-documented indirect-injection pattern: a
 * poisoned page embeds dozens of pre-built candidate URLs — classically all on
 * the SAME origin, one per secret character — and asks the model to "open the
 * one matching each character", turning link SELECTION into an exfil
 * channel). Bounding the number of distinct untrusted-host URLs a run may
 * follow to a handful of bits does not eliminate that channel — it is an
 * irreducible residual (documented, not claimed closed) — but it denies an
 * attacker the full dictionary in one run. Budget is charged per distinct
 * CANONICAL URL, not per host — same-host distinct URLs each consume it,
 * which is the shape the real attack takes. A URL whose host is
 * TRUSTED-observed is exempt (ordinary browsing on a trusted site stays
 * unlimited). 3 is generous for ordinary link-following (a page and a couple
 * of its own links) while still capping the side-channel hard.
 */
export const DEFAULT_EGRESS_FAN_OUT_CAP = 3;

const MAX_PERCENT_DECODE_ROUNDS = 5;
const URL_IN_TEXT_PATTERN = /(?:https?|wss?):\/\/[^\s"'<>]+/giu;
const SENTENCE_TRAILING_PUNCTUATION_PATTERN = /[.,;:!?'"]+$/u;
const CLOSING_TO_OPENING_BRACKET: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };
const MAX_WALK_DEPTH = 20;

function countOccurrences(value: string, char: string): number {
  let count = 0;
  for (const ch of value) {
    if (ch === char) {
      count += 1;
    }
  }
  return count;
}

/**
 * Trim trailing punctuation off a URL match — the ONE rule shared by
 * extraction (observed side) and normalization (candidate side) so they can
 * never mangle a URL differently and diverge. Sentence punctuation
 * (`.,;:!?'"`) is always trailing noise and is stripped unconditionally. A
 * trailing bracket/paren (`)]}`) is stripped ONLY when it is unbalanced
 * within the string (more closes than opens of that kind) — the common case
 * of a URL wrapped in prose parens, e.g. "(https://example.com/x)". A
 * BALANCED trailing bracket — e.g. Wikipedia's
 * "https://en.wikipedia.org/wiki/Mercury_(planet)" — is part of the URL path
 * and survives.
 */
function trimTrailingPunctuation(url: string): string {
  let result = url;
  for (;;) {
    const sentenceMatch = result.match(SENTENCE_TRAILING_PUNCTUATION_PATTERN);
    if (sentenceMatch) {
      result = result.slice(0, result.length - sentenceMatch[0].length);
      continue;
    }
    const lastChar = result.charAt(result.length - 1);
    const opening = CLOSING_TO_OPENING_BRACKET[lastChar];
    if (opening && countOccurrences(result, lastChar) > countOccurrences(result, opening)) {
      result = result.slice(0, -1);
      continue;
    }
    return result;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#0*39;|&apos;/giu, "'")
    .replace(/&#0*47;|&#x0*2f;/giu, "/");
}

// Bounded so a malformed/adversarial percent-sequence can't loop forever or
// blow the stack; stops as soon as decoding no longer changes the string OR
// a round fails to decode (a literal `%` that isn't a valid escape).
function boundedPercentDecode(text: string): string {
  let current = text;
  for (let round = 0; round < MAX_PERCENT_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

export interface NormalizedEgressUrl {
  /** Canonical comparison key: lowercase scheme+host, default port stripped, bare "/" stripped. */
  readonly canonical: string;
  readonly host: string;
  readonly scheme: string;
  /** No query, no fragment, path is empty or "/" — the ONLY shape the bare-origin bootstrap rule allows. */
  readonly isBareOrigin: boolean;
}

/**
 * Normalize a candidate URL string for provenance comparison. Applies (both
 * sides of every comparison go through this, never URL-to-prose): HTML-entity
 * decode, bounded recursive percent-decode, then parses the decoded form (or
 * falls back to the raw form if decoding breaks it) as an absolute URL,
 * lowercases scheme+host, strips a default port, strips a trailing dot on the
 * host, collapses a bare "/" path to empty, and NFC-normalizes the result.
 * Returns `null` for anything that isn't an http(s)/ws(s) absolute URL.
 */
export function normalizeEgressUrl(raw: string): NormalizedEgressUrl | null {
  const trimmed = trimTrailingPunctuation(raw.trim());
  if (trimmed.length === 0) {
    return null;
  }
  const decoded = boundedPercentDecode(decodeHtmlEntities(trimmed));
  let parsed: URL | undefined;
  for (const candidate of [decoded, trimmed]) {
    try {
      const url = new URL(candidate);
      if (SUPPORTED_SCHEMES.has(url.protocol.toLowerCase())) {
        parsed = url;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!parsed) {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  const defaultPorts: Record<string, string> = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443" };
  const host = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  const port = parsed.port && parsed.port !== defaultPorts[scheme] ? `:${parsed.port}` : "";
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const search = parsed.search;
  const hash = parsed.hash;
  const canonical = `${scheme}//${host}${port}${path}${search}${hash}`.normalize("NFC");
  return {
    canonical,
    host,
    isBareOrigin: path.length === 0 && search.length === 0 && hash.length === 0,
    scheme
  };
}

/** Extract URL-shaped substrings WITHIN a string (a URL embedded in prose counts, not just a whole-string parse). */
export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(URL_IN_TEXT_PATTERN) ?? [];
  return matches.map((match) => trimTrailingPunctuation(match));
}

/**
 * Recursively walk every string leaf of an arbitrary value (object/array
 * nesting included) and extract every URL found. This is the value-SHAPE sink
 * detector: it catches a URL buried in `headers` map values, `fields` arrays
 * on a form-fill call, or any nested arg shape — deliberately NOT keyed by
 * tool name, since an external MCP server names and risk-classes itself.
 * Depth-bounded so a pathologically nested payload can't blow the stack.
 */
export function collectUrlsFromValue(value: unknown, depth = 0): string[] {
  if (depth > MAX_WALK_DEPTH) {
    return [];
  }
  if (typeof value === "string") {
    return extractUrlsFromText(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectUrlsFromValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item) => collectUrlsFromValue(item, depth + 1));
  }
  return [];
}

export type EgressDecisionKind = "allow" | "confirm" | "deny";

export interface EgressDecision {
  readonly decision: EgressDecisionKind;
  readonly reason: string;
  /** The raw candidate as seen; present even when normalization failed (decision is then always "deny"). */
  readonly url: string;
}

export interface EgressAuthority {
  readonly fanOutCap: number;
  /** Record text from an AUTHORIZING trusted source: the user's own message, an assembled system/context block, or config (feed URL / fetch allowlist). URLs found become trusted-observed. */
  recordTrustedText(text: string): void;
  /** Record text from an untrusted tool result / fetched page / email body / feed item. URLs found become untrusted-observed (still subject to the fan-out cap). */
  recordUntrustedText(text: string): void;
  /** Register a host directly as trusted (e.g. a configured allowlist entry that is a bare host, not a full URL). */
  recordTrustedHost(host: string): void;
  isTrustedUrl(canonicalUrl: string): boolean;
  isUntrustedObservedUrl(canonicalUrl: string): boolean;
  isTrustedHost(host: string): boolean;
  /**
   * Consume (or check-and-consume) this run's fan-out budget for the given
   * CANONICAL untrusted-host URL. A URL already admitted this run doesn't
   * re-consume budget (re-checking the SAME link repeatedly isn't additional
   * fan-out) — but budget is charged per distinct URL, not per host, so
   * distinct same-host URLs (the CamoLeak same-origin dictionary shape) each
   * consume it. Returns false once distinct untrusted-host URLs admitted
   * this run exceed `fanOutCap`.
   */
  admitFanOut(canonicalUrl: string): boolean;
}

/** Per-run egress authority. Construct once per agent run (mirrors `createTaintLedger`). */
export function createEgressAuthority(options?: { readonly fanOutCap?: number }): EgressAuthority {
  const trustedUrls = new Set<string>();
  const untrustedUrls = new Set<string>();
  const trustedHosts = new Set<string>();
  const admittedUrls = new Set<string>();
  const fanOutCap = options?.fanOutCap ?? DEFAULT_EGRESS_FAN_OUT_CAP;

  function recordText(text: string, urlSet: Set<string>, hostSet?: Set<string>): void {
    if (text.trim().length === 0) {
      return;
    }
    for (const raw of extractUrlsFromText(text)) {
      const normalized = normalizeEgressUrl(raw);
      if (!normalized) {
        continue;
      }
      urlSet.add(normalized.canonical);
      hostSet?.add(normalized.host);
    }
  }

  return {
    admitFanOut(canonicalUrl: string): boolean {
      if (admittedUrls.has(canonicalUrl)) {
        return true;
      }
      if (admittedUrls.size >= fanOutCap) {
        return false;
      }
      admittedUrls.add(canonicalUrl);
      return true;
    },
    fanOutCap,
    isTrustedHost(host: string): boolean {
      return trustedHosts.has(host.toLowerCase());
    },
    isTrustedUrl(canonicalUrl: string): boolean {
      return trustedUrls.has(canonicalUrl);
    },
    isUntrustedObservedUrl(canonicalUrl: string): boolean {
      return untrustedUrls.has(canonicalUrl);
    },
    recordTrustedHost(host: string): void {
      trustedHosts.add(host.toLowerCase());
    },
    recordTrustedText(text: string): void {
      recordText(text, trustedUrls, trustedHosts);
    },
    recordUntrustedText(text: string): void {
      recordText(text, untrustedUrls);
    }
  };
}

/**
 * Decide the fate of a single candidate URL against the run's observed sets.
 * Pure — `authority.admitFanOut` is the only mutation, and only on the
 * confirm path (an allow/deny never spends fan-out budget).
 *
 *   1. allow  — normalized URL is in the TRUSTED-observed set (quoted from
 *      something typed, the user's own stores, or config).
 *   2. allow  — the URL is a BARE ORIGIN (no query/fragment, path <= "/")
 *      whose host is TRUSTED-observed. An untrusted-only host does not
 *      bootstrap here — that would let an attacker's own page turn itself
 *      into a trusted source.
 *   3. confirm — normalized URL is in the UNTRUSTED-observed set
 *      (link-following) and EITHER its host is TRUSTED-observed (ordinary
 *      browsing on a trusted site is exempt from the cap) OR the run is
 *      still under the fan-out cap (charged per distinct URL, not per host).
 *   4. deny   — beyond the fan-out cap for an untrusted-host URL, or the URL
 *      was never observed anywhere (model-composed), or it isn't a
 *      recognizable http(s)/ws(s) URL at all.
 */
export function authorizeEgress(rawUrl: string, authority: EgressAuthority): EgressDecision {
  const normalized = normalizeEgressUrl(rawUrl);
  if (!normalized) {
    return { decision: "deny", reason: "not a recognizable http(s)/ws(s) URL", url: rawUrl };
  }
  if (authority.isTrustedUrl(normalized.canonical)) {
    return {
      decision: "allow",
      reason: "quoted verbatim from something you typed, your own stores, or configured trust",
      url: normalized.canonical
    };
  }
  if (normalized.isBareOrigin && authority.isTrustedHost(normalized.host)) {
    return {
      decision: "allow",
      reason: `bare origin of a trusted-observed host (${normalized.host})`,
      url: normalized.canonical
    };
  }
  if (authority.isUntrustedObservedUrl(normalized.canonical)) {
    if (authority.isTrustedHost(normalized.host)) {
      return {
        decision: "confirm",
        reason: `quoted from a page or tool result read this run — host (${normalized.host}) is trusted-observed, exempt from the fan-out cap`,
        url: normalized.canonical
      };
    }
    if (authority.admitFanOut(normalized.canonical)) {
      return {
        decision: "confirm",
        reason: "quoted from a page or tool result read this run — link-following under the fan-out cap",
        url: normalized.canonical
      };
    }
    return {
      decision: "deny",
      reason: `fan-out cap (${authority.fanOutCap.toString()}) exceeded for distinct untrusted-host links this run`,
      url: normalized.canonical
    };
  }
  return {
    decision: "deny",
    reason: "URL was not observed in anything you typed, your own stores, or read this run — looks model-composed",
    url: normalized.canonical
  };
}

/**
 * Worst-of over every URL found in an arbitrary tool-call argument value
 * (deny > confirm > allow). Returns `undefined` when the value carries no
 * http(s)/ws(s) URL at all — callers treat that as "no egress signal",
 * preserving byte-identical behaviour for calls with no URL args.
 */
export function authorizeEgressForValue(value: unknown, authority: EgressAuthority): EgressDecision | undefined {
  const urls = collectUrlsFromValue(value);
  if (urls.length === 0) {
    return undefined;
  }
  const rank: Record<EgressDecisionKind, number> = { allow: 0, confirm: 1, deny: 2 };
  let worst: EgressDecision | undefined;
  for (const url of urls) {
    const decision = authorizeEgress(url, authority);
    if (!worst || rank[decision.decision] > rank[worst.decision]) {
      worst = decision;
    }
  }
  return worst;
}
