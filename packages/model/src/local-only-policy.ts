/**
 * Deterministic local-only / no-cloud-egress policy. When the user runs
 * Muse for privacy/security on local open-source models only, this is
 * the fail-close gate: it classifies a resolved model target as `local`
 * (never leaves the user's machine) or `cloud` (reaches a third-party
 * LLM API), so the runtime can refuse to start against a cloud provider
 * — deterministic code, never a prompt instruction.
 */

import { parseBooleanFromEnv } from "@muse/shared";

export type ProviderLocality = "local" | "cloud";
const LOCAL_ONLY_OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * Provider ids whose traffic stays on the user's own machine — local
 * inference servers. A remote *host* for one of these is still off-box
 * egress, so the base URL is checked below; the id alone is not enough.
 */
const LOCAL_INFERENCE_PROVIDER_IDS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "diagnostic"]);

/**
 * Provider ids that ALWAYS reach a third-party cloud LLM API. `codex` shells to
 * the official codex CLI which egresses to OpenAI via the user's ChatGPT
 * subscription — cloud regardless of any base URL, so it is fail-closed under
 * `MUSE_LOCAL_ONLY=true` before the adapter is constructed.
 */
const CLOUD_PROVIDER_IDS: ReadonlySet<string> = new Set(["openai", "anthropic", "gemini", "openrouter", "codex"]);

/**
 * True when `raw` points at the local loopback interface (localhost,
 * 127.0.0.0/8, ::1, or a `.localhost` name). A bare host with no scheme
 * is tolerated. Anything unparseable or off-box is NOT loopback.
 */
export function isLoopbackUrl(raw: string | undefined): boolean {
  const value = raw?.trim();
  if (!value) {
    return false;
  }
  // A bare `localhost:11434` parses with "localhost" as the SCHEME (empty
  // host), so only treat the string as already-schemed when it has `://`;
  // otherwise give it an http scheme so the host is parsed correctly.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return false;
  }
  const hostname = host.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "::1"
    || isIpv4Loopback(hostname);
}

/** `MUSE_LOCAL_ONLY` is enabled only by its established explicit truthy spellings. */
export function isLocalOnlyEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return parseBooleanFromEnv(env["MUSE_LOCAL_ONLY"], false);
}

/**
 * Produces the endpoint an actual local-only model transport may use. This is
 * intentionally narrower than `isLoopbackUrl`: `.localhost`, TLS localhost,
 * wildcard binds, userinfo, and every non-numeric hostname are refused instead
 * of being classified then handed back to a resolver on the fetch path.
 */
export function canonicalizeLocalOnlyModelBaseUrl(providerId: string, rawBaseUrl: string | undefined): string | undefined {
  if (rawBaseUrl === undefined || rawBaseUrl.trim().length === 0) {
    return providerId.trim().toLowerCase() === "ollama" ? LOCAL_ONLY_OLLAMA_DEFAULT_BASE_URL : undefined;
  }

  return canonicalizeStrictLoopbackHttpBaseUrl(rawBaseUrl, {
    allowNonRootPath: true,
    onViolation: (original) => {
      throw new LocalOnlyViolationError(providerId, original);
    }
  });
}

/**
 * Produces a machine-loopback HTTP endpoint for a local personal
 * integration. Unlike model endpoints this intentionally accepts only a
 * host plus optional port (and one optional trailing slash): an integration
 * must not inherit model `/v1` / reverse-proxy path compatibility by accident.
 */
export function canonicalizeLocalOnlyRootLoopbackHttpBaseUrl(rawBaseUrl: string): string {
  const original = rawBaseUrl.trim();
  // URL normalisation is intentionally not enough for an integration
  // endpoint: it can erase an empty userinfo marker, a trailing `?` / `#`,
  // dot-segment paths, and non-canonical numeric host spellings. HA's
  // local-only contract is host[:port] plus an optional single `/`, so
  // classify the raw authority/path spelling before URL turns it into a
  // friendlier-looking endpoint.
  if (!hasCanonicalRootLoopbackHttpSyntax(original)) {
    throw new LocalOnlyHttpBaseUrlViolationError(original);
  }
  return canonicalizeStrictLoopbackHttpBaseUrl(rawBaseUrl, {
    allowNonRootPath: false,
    onViolation: (original) => {
      throw new LocalOnlyHttpBaseUrlViolationError(original);
    }
  });
}

function hasCanonicalRootLoopbackHttpSyntax(original: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(original);
  if (!scheme || scheme[1]!.toLowerCase() !== "http") {
    return false;
  }
  // Even an empty query/hash marker is a non-root URL component. Reject them
  // before the WHATWG URL parser normalises them away.
  if (original.includes("?") || original.includes("#")) {
    return false;
  }
  const afterScheme = original.slice(scheme[0].length);
  const slashAt = afterScheme.indexOf("/");
  const authority = slashAt === -1 ? afterScheme : afterScheme.slice(0, slashAt);
  const rawPath = slashAt === -1 ? "" : afterScheme.slice(slashAt);
  if ((rawPath !== "" && rawPath !== "/") || authority.includes("@")) {
    return false;
  }

  const hostAndPort = splitCanonicalHostAndPort(authority);
  if (!hostAndPort) {
    return false;
  }
  const { host, port } = hostAndPort;
  if (port !== undefined && !/^\d+$/u.test(port)) {
    return false;
  }
  return host.toLowerCase() === "localhost"
    || host === "[::1]"
    || isCanonicalIpv4Loopback(host);
}

function splitCanonicalHostAndPort(authority: string): { readonly host: string; readonly port?: string } | undefined {
  if (authority.startsWith("[")) {
    const closeAt = authority.indexOf("]");
    if (closeAt === -1) {
      return undefined;
    }
    const host = authority.slice(0, closeAt + 1);
    const suffix = authority.slice(closeAt + 1);
    if (suffix.length === 0) {
      return { host };
    }
    return suffix.startsWith(":") ? { host, port: suffix.slice(1) } : undefined;
  }
  const colonAt = authority.indexOf(":");
  if (colonAt === -1) {
    return authority.length > 0 ? { host: authority } : undefined;
  }
  // A non-bracketed host has at most one colon: IPv6 must use [::1].
  if (colonAt !== authority.lastIndexOf(":")) {
    return undefined;
  }
  const host = authority.slice(0, colonAt);
  const port = authority.slice(colonAt + 1);
  return host.length > 0 ? { host, port } : undefined;
}

function isCanonicalIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/u.test(part))
    // Do not let URL canonicalisation reinterpret octal-like / abbreviated
    // numerical forms. `127.0.0.1` stays an auditable literal authority.
    && parts.every((part) => String(Number(part)) === part)
    && isIpv4Loopback(hostname);
}

interface StrictLoopbackHttpBaseUrlOptions {
  readonly allowNonRootPath: boolean;
  readonly onViolation: (original: string) => never;
}

function canonicalizeStrictLoopbackHttpBaseUrl(
  rawBaseUrl: string,
  options: StrictLoopbackHttpBaseUrlOptions
): string {
  const original = rawBaseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(original);
  } catch {
    return options.onViolation(original);
  }
  if (
    parsed.protocol !== "http:"
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    return options.onViolation(original);
  }
  if (!options.allowNonRootPath && parsed.pathname !== "/") {
    return options.onViolation(original);
  }

  const hostname = parsed.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  if (hostname === "localhost") {
    parsed.hostname = "127.0.0.1";
  } else if (!isIpv4Loopback(hostname) && hostname !== "::1") {
    return options.onViolation(original);
  }

  return parsed.toString().replace(/\/$/u, "");
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/u.test(part))
    && parts.every((part) => Number(part) >= 0 && Number(part) <= 255)
    && Number(parts[0]) === 127;
}

/**
 * Classify a resolved model target. `effectiveBaseUrl` is the base URL
 * the provider will actually use (an Ollama default of undefined means
 * its built-in 127.0.0.1, i.e. local). Cloud-id providers are cloud
 * regardless of base URL; local-inference ids are local only when their
 * host is loopback; anything else (openai-compatible / unknown) is
 * local only when pointed at a loopback host.
 */
export function classifyProviderLocality(providerId: string, effectiveBaseUrl: string | undefined): ProviderLocality {
  const id = providerId.trim().toLowerCase();
  if (CLOUD_PROVIDER_IDS.has(id)) {
    return "cloud";
  }
  if (LOCAL_INFERENCE_PROVIDER_IDS.has(id)) {
    return effectiveBaseUrl === undefined || isLoopbackUrl(effectiveBaseUrl) ? "local" : "cloud";
  }
  return isLoopbackUrl(effectiveBaseUrl) ? "local" : "cloud";
}

/**
 * Thrown at runtime assembly when `MUSE_LOCAL_ONLY` is on but the
 * selected model would reach a cloud provider. A LOUD failure on
 * purpose: silently disabling the runtime would hide a privacy
 * violation the user explicitly asked to be protected from.
 */
export class LocalOnlyViolationError extends Error {
  readonly code = "LOCAL_ONLY_VIOLATION";
  readonly providerId: string;
  readonly baseUrl: string | undefined;

  constructor(providerId: string, baseUrl?: string) {
    super(
      `Muse's local-only model posture is enforced here in code, `
      + `but the selected model endpoint targets the cloud provider `
      + `'${providerId}'${baseUrl ? ` (${baseUrl})` : ""}. `
      + `Point Muse at a local model (e.g. MUSE_MODEL=ollama/qwen3:8b, or a localhost `
      + `OpenAI-compatible MUSE_MODEL_BASE_URL) — or set MUSE_LOCAL_ONLY=false to use the `
      + `cloud provider, which permits cloud model egress.`
    );
    this.name = "LocalOnlyViolationError";
    this.providerId = providerId;
    this.baseUrl = baseUrl;
  }
}

/**
 * A local personal integration supplied a base URL that is not a strict
 * loopback HTTP root. Kept separate from LocalOnlyViolationError so callers
 * do not present an LLM-model remediation message for a non-model transport.
 */
export class LocalOnlyHttpBaseUrlViolationError extends Error {
  readonly code = "LOCAL_ONLY_HTTP_BASE_URL_VIOLATION";
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    super(
      "Muse's local-only posture permits this personal integration only on a "
      + `loopback HTTP root endpoint; refused '${baseUrl}'. Use http://127.0.0.1:<port> `
      + "or http://[::1]:<port>, or set MUSE_LOCAL_ONLY=false to allow a remote integration."
    );
    this.name = "LocalOnlyHttpBaseUrlViolationError";
    this.baseUrl = baseUrl;
  }
}
