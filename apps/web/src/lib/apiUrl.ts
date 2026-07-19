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
// Default API base when the user saved none. A production bundle is only ever
// served by the Muse API server itself (muse serve / the desktop shell's http
// origin), so same-origin is both correct and the only choice that satisfies
// the server's `default-src 'self'` CSP under EVERY host alias (localhost vs
// 127.0.0.1 vs a LAN IP — a hardcoded 127.0.0.1 breaks all the others). The
// dev server (vite :5173) and non-http pages (file://) are not the API, so
// they keep the historical loopback default.
export function defaultApiBaseUrl(
  location: { readonly protocol: string; readonly origin: string } | undefined,
  isDevServer: boolean
): string {
  if (location && !isDevServer && (location.protocol === "http:" || location.protocol === "https:")) {
    return location.origin;
  }
  return "http://127.0.0.1:3030";
}

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
