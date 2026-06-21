export interface NormalizedApiUrl {
  /** The cleaned URL (scheme added, trailing slash removed) — or the raw input when invalid. */
  readonly url: string;
  readonly valid: boolean;
}

// Normalize + validate a user-typed API base URL. The API client builds every
// request with `new URL(path, baseUrl)`, so a base without a scheme (e.g.
// "127.0.0.1:3030", which `new URL` reads as scheme "127.0.0.1:") silently
// breaks every call. We add a default http:// scheme, strip a trailing slash,
// and reject empties / non-http schemes / hostless garbage so a mistyped URL is
// caught at save time instead of failing every request later.
export function normalizeApiBaseUrl(input: string): NormalizedApiUrl {
  const trimmed = input.trim();
  if (!trimmed) return { url: "", valid: false };
  // An explicit non-http(s) scheme (ftp://, file://, …) is not a usable API base.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return { url: trimmed, valid: false };
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { url: trimmed, valid: false };
  }
  if (!parsed.hostname) return { url: trimmed, valid: false };
  const path = parsed.pathname.replace(/\/+$/, "");
  return { url: `${parsed.protocol}//${parsed.host}${path}${parsed.search}`, valid: true };
}
