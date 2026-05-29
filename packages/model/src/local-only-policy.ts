/**
 * Deterministic local-only / no-cloud-egress policy. When the user runs
 * Muse for privacy/security on local open-source models only, this is
 * the fail-close gate: it classifies a resolved model target as `local`
 * (never leaves the user's machine) or `cloud` (reaches a third-party
 * LLM API), so the runtime can refuse to start against a cloud provider
 * — deterministic code, never a prompt instruction.
 */

export type ProviderLocality = "local" | "cloud";

/**
 * Provider ids whose traffic stays on the user's own machine — local
 * inference servers. A remote *host* for one of these is still off-box
 * egress, so the base URL is checked below; the id alone is not enough.
 */
const LOCAL_INFERENCE_PROVIDER_IDS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "diagnostic"]);

/** Provider ids that ALWAYS reach a third-party cloud LLM API. */
const CLOUD_PROVIDER_IDS: ReadonlySet<string> = new Set(["openai", "anthropic", "gemini", "openrouter"]);

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
  return (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "::1"
    || hostname === "0.0.0.0"
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
  );
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
      `Muse runs local-only by default (nothing leaves your machine — enforced here in code), `
      + `but the selected model targets the cloud provider `
      + `'${providerId}'${baseUrl ? ` (${baseUrl})` : ""}. `
      + `Point Muse at a local model (e.g. MUSE_MODEL=ollama/qwen3:8b, or a localhost `
      + `OpenAI-compatible MUSE_MODEL_BASE_URL) — or set MUSE_LOCAL_ONLY=false to use the `
      + `cloud provider, which forfeits the zero-egress privacy guarantee.`
    );
    this.name = "LocalOnlyViolationError";
    this.providerId = providerId;
    this.baseUrl = baseUrl;
  }
}
