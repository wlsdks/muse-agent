import { errorMessage } from "@muse/shared";
/**
 * Manual public-http redirect state machine. It owns redirect policy but not
 * retries: `fetchWithRetry` owns every physical request and invokes this
 * module's sole `beforeAttempt` guard immediately before it.
 */

import { fetchWithRetry, type BeforeAttempt, type RetryOptions } from "@muse/mcp-shared";

import { assertPublicHttpUrl, type HostLookup } from "./web-url-guard.js";
import { pinnedPublicFetch } from "./public-http-pinned-fetch.js";

export const MAX_PUBLIC_HTTP_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_HEADER_ALLOWLIST = new Set(["accept", "accept-language", "user-agent"]);

export type PublicRedirectCode =
  | "PUBLIC_REDIRECT_BLOCKED_TARGET"
  | "PUBLIC_REDIRECT_INVALID_LOCATION"
  | "PUBLIC_REDIRECT_INVALID_REQUEST"
  | "PUBLIC_REDIRECT_LIMIT"
  | "PUBLIC_REDIRECT_LOOP"
  | "PUBLIC_REDIRECT_MISSING_LOCATION";

export type PublicHttpRedirectFailure =
  | {
    readonly ok: false;
    readonly phase: "initial";
    readonly code: "PUBLIC_INITIAL_INVALID_URL" | "PUBLIC_INITIAL_GUARD" | "PUBLIC_REDIRECT_INVALID_REQUEST";
    readonly message: string;
  }
  | {
    readonly ok: false;
    readonly phase: "redirect";
    readonly code: Exclude<PublicRedirectCode, "PUBLIC_REDIRECT_INVALID_REQUEST">;
    readonly message: string;
  };

export type PublicHttpRedirectResult =
  | { readonly ok: true; readonly response: Response; readonly finalUrl: string }
  | PublicHttpRedirectFailure;

export interface FetchPublicHttpOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Consumer-owned defaults, merged before retryOptions.init. */
  readonly init?: RequestInit;
  readonly lookup?: HostLookup;
  readonly retryOptions?: RetryOptions;
}

class PublicRedirectGuardFailure extends Error {
  constructor(readonly failure: PublicHttpRedirectFailure) {
    super(failure.message);
    this.name = "PublicRedirectGuardFailure";
  }
}

// The raw WHATWG DOMException text ("invalid URL: Invalid URL") named neither
// the rejected value nor the expected shape — mirror web-url-guard's message so
// every public-http entry point gives the model something it can act on.
function messageForInitialInvalidUrl(rawUrl: string): string {
  return `invalid URL: 'url' must be an absolute http(s) URL including the scheme, e.g. 'https://example.com/article' (got ${JSON.stringify(rawUrl)})`;
}

function invalidRequest(message: string): PublicHttpRedirectFailure {
  return { code: "PUBLIC_REDIRECT_INVALID_REQUEST", message, ok: false, phase: "initial" };
}

function validateGetOnlyInit(init: RequestInit | undefined): PublicHttpRedirectFailure | undefined {
  if (!init) return undefined;
  if (init.method !== undefined && init.method.toUpperCase() !== "GET") {
    return invalidRequest("public redirect requests must use GET");
  }
  if (init.body !== undefined && init.body !== null) {
    return invalidRequest("public redirect requests must not include a body");
  }
  return undefined;
}

function mergedHeaders(base: HeadersInit | undefined, override: HeadersInit | undefined): Headers {
  const headers = new Headers(base);
  for (const [name, value] of new Headers(override)) {
    headers.set(name, value);
  }
  return headers;
}

function pickSafeGetInit(base: RequestInit | undefined, override: RequestInit | undefined, headers: Headers): RequestInit {
  const pick = <K extends keyof RequestInit>(key: K): RequestInit[K] => override?.[key] ?? base?.[key];
  const init: RequestInit = { headers, method: "GET", redirect: "manual" };
  const cache = pick("cache");
  const credentials = pick("credentials");
  const integrity = pick("integrity");
  const keepalive = pick("keepalive");
  const mode = pick("mode");
  const referrer = pick("referrer");
  const referrerPolicy = pick("referrerPolicy");
  const signal = pick("signal");
  if (cache !== undefined) init.cache = cache;
  if (credentials !== undefined) init.credentials = credentials;
  if (integrity !== undefined) init.integrity = integrity;
  if (keepalive !== undefined) init.keepalive = keepalive;
  if (mode !== undefined) init.mode = mode;
  if (referrer !== undefined) init.referrer = referrer;
  if (referrerPolicy !== undefined) init.referrerPolicy = referrerPolicy;
  if (signal !== undefined) init.signal = signal;
  return init;
}

function redirectHeaders(initial: Headers): Headers {
  const safe = new Headers();
  for (const [name, value] of initial) {
    if (REDIRECT_HEADER_ALLOWLIST.has(name.toLowerCase())) {
      safe.set(name, value);
    }
  }
  return safe;
}

function redirectedGetInit(initial: RequestInit, headers: Headers): RequestInit {
  const init = pickSafeGetInit(initial, undefined, headers);
  // Header filtering alone is insufficient in browser-like fetch
  // implementations: credentials:include can synthesize Cookie outside the
  // Headers object. Redirect hops are deliberately anonymous and referrer-free.
  init.credentials = "omit";
  init.referrerPolicy = "no-referrer";
  return init;
}

function redirectFailure(code: Exclude<PublicRedirectCode, "PUBLIC_REDIRECT_INVALID_REQUEST">, message: string): PublicHttpRedirectFailure {
  return { code, message, ok: false, phase: "redirect" };
}

/**
 * Fetch one public http(s) resource with explicit, preflighted redirects.
 * `response.url` is intentionally ignored: only the state machine's canonical
 * current URL can become `finalUrl` or a user-visible citation source.
 */
export async function fetchPublicHttpWithRedirects(
  rawUrl: string,
  options: FetchPublicHttpOptions = {}
): Promise<PublicHttpRedirectResult> {
  let initialUrl: URL;
  try {
    initialUrl = new URL(rawUrl);
  } catch {
    return { code: "PUBLIC_INITIAL_INVALID_URL", message: messageForInitialInvalidUrl(rawUrl), ok: false, phase: "initial" };
  }
  initialUrl.hash = "";

  const baseInit = options.init;
  const retryInit = options.retryOptions?.init;
  const baseInvalid = validateGetOnlyInit(baseInit);
  if (baseInvalid) return baseInvalid;
  const retryInvalid = validateGetOnlyInit(retryInit);
  if (retryInvalid) return retryInvalid;

  let initialHeaders: Headers;
  try {
    initialHeaders = mergedHeaders(baseInit?.headers, retryInit?.headers);
  } catch (error) {
    return invalidRequest(`public redirect request headers are invalid: ${errorMessage(error)}`);
  }
  const initialInit = pickSafeGetInit(baseInit, retryInit, initialHeaders);
  const redirectedInit = redirectedGetInit(initialInit, redirectHeaders(initialHeaders));
  const { beforeAttempt: callerBeforeAttempt, init: _retryInit, ...retryWithoutInit } = options.retryOptions ?? {};
  // Production default pins the connection to a connect-time-validated public
  // address (closes the DNS-rebinding TOCTOU the preflight guard leaves open);
  // an injected fetchImpl (tests) is used verbatim.
  const fetchImpl = options.fetchImpl ?? pinnedPublicFetch;
  const lookupOptions = options.lookup ? { lookup: options.lookup } : {};
  const visited = new Set<string>([initialUrl.href]);
  let followsAlready = 0;
  let currentUrl = initialUrl.href;

  const fetchHop = async (phase: "initial" | "redirect", init: RequestInit): Promise<Response | PublicHttpRedirectFailure> => {
    let countedFollow = false;
    const guardedBeforeAttempt: BeforeAttempt = async (context) => {
      const guard = await assertPublicHttpUrl(context.url, lookupOptions);
      if (!guard.ok) {
        const failure: PublicHttpRedirectFailure = phase === "initial"
          ? { code: "PUBLIC_INITIAL_GUARD", message: guard.error, ok: false, phase: "initial" }
          : redirectFailure("PUBLIC_REDIRECT_BLOCKED_TARGET", `redirected to a blocked host: ${guard.error}`);
        throw new PublicRedirectGuardFailure(failure);
      }
      await callerBeforeAttempt?.(context);
      if (phase === "redirect" && !countedFollow) {
        // Retry attempts do not mutate redirect state. This happens after the
        // one successful candidate preflight and immediately before fetchImpl.
        visited.add(context.url);
        followsAlready += 1;
        countedFollow = true;
      }
    };
    try {
      return await fetchWithRetry(fetchImpl, currentUrl, {
        ...retryWithoutInit,
        beforeAttempt: guardedBeforeAttempt,
        init
      });
    } catch (error) {
      if (error instanceof PublicRedirectGuardFailure) return error.failure;
      throw error;
    }
  };

  let phase: "initial" | "redirect" = "initial";
  let init = initialInit;
  for (;;) {
    const fetched = await fetchHop(phase, init);
    if ("phase" in fetched) return fetched;
    if (!REDIRECT_STATUSES.has(fetched.status)) {
      return { finalUrl: currentUrl, ok: true, response: fetched };
    }
    // The sixth response is allowed to be received but cannot authorize a
    // seventh request; limit wins before Location is observed.
    if (followsAlready === MAX_PUBLIC_HTTP_REDIRECTS) {
      return redirectFailure("PUBLIC_REDIRECT_LIMIT", `redirect limit exceeded (${MAX_PUBLIC_HTTP_REDIRECTS.toString()} follows maximum)`);
    }
    const location = fetched.headers.get("location")?.trim();
    if (!location) {
      return redirectFailure("PUBLIC_REDIRECT_MISSING_LOCATION", "redirect response did not include a Location header");
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return redirectFailure("PUBLIC_REDIRECT_INVALID_LOCATION", "redirect Location is not a valid URL");
    }
    nextUrl.hash = "";
    if (visited.has(nextUrl.href)) {
      return redirectFailure("PUBLIC_REDIRECT_LOOP", "redirect loop detected");
    }
    currentUrl = nextUrl.href;
    phase = "redirect";
    init = redirectedInit;
  }
}
