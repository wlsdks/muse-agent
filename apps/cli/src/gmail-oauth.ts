import { errorMessage } from "@muse/shared";
/**
 * Gmail OAuth 2.0 (installed-app / loopback flow), raw fetch only — no
 * vendor SDK (architecture.md). Literal endpoints/params per Google's
 * official doc (developers.google.com/identity/protocols/oauth2/native-app):
 * authorization at `accounts.google.com/o/oauth2/v2/auth` (PKCE, S256),
 * token + refresh both at `oauth2.googleapis.com/token`.
 *
 * Two consumers:
 *  - `setup-email.ts` calls `exchangeGmailAuthorizationCode` once, at the
 *    end of the wizard's loopback flow.
 *  - `createGmailTokenSource` is the runtime seam every Gmail provider
 *    construction site resolves through (via resolve-gmail-provider.ts):
 *    returns the cached access token while it has >60s of life, otherwise
 *    refreshes and persists the new one. Single-flight per token source
 *    instance so concurrent callers (e.g. email_send + email_reply sharing
 *    one provider) share the same in-flight refresh.
 */

import type { MuseEnvironment } from "@muse/autoconfigure";

import { readGmailCredential, writeGmailCredential, type GmailOAuthCredential } from "./credential-store.js";
import type { ProgramIO } from "./program.js";

export const GMAIL_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

/** No Gmail account connected at all — distinct from an expired/revoked one so the caller's hint can differ. */
export class GmailNotConfiguredError extends Error {}

/**
 * The token endpoint returned `invalid_grant` on a REFRESH — the refresh
 * token itself is revoked or expired. The only correct handling (never a
 * retry loop): tell the user to run `muse setup email` again.
 */
export class GmailOAuthInvalidGrantError extends Error {}

/** A 5xx or network failure talking to the token endpoint — transient, safe to retry later, never mutates stored token state. */
export class GmailOAuthRetryableError extends Error {}

export interface GmailClientPreflightResult {
  readonly ok: boolean;
  /** true when the probe couldn't run (network) — advisory only, never blocks setup. */
  readonly skipped?: boolean;
  readonly errorCode?: string;
  readonly message?: string;
}

/**
 * Google's authorization endpoint 302-redirects a bad client_id to
 * `/signin/oauth/error?authError=<base64url blob>` BEFORE any consent UI.
 * Probing it lets the wizard explain "invalid_client" in the terminal
 * instead of the user meeting Google's opaque error page in the browser.
 * The blob is a length-prefixed proto (field 1 = error code, field 2 =
 * human message) — extracting printable runs is enough and avoids a proto
 * dependency.
 */
export function decodeGoogleAuthError(blob: string): { readonly code?: string; readonly message?: string } | undefined {
  try {
    const runs = Buffer.from(blob, "base64url").toString("latin1").match(/[\x20-\x7e]{4,}/gu) ?? [];
    if (runs.length === 0) return undefined;
    return { code: runs[0]?.trim(), message: runs[1]?.trim() };
  } catch {
    return undefined;
  }
}

export function validateGoogleOAuthClientIdInput(input: string | undefined): string | undefined {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) return "Client ID is required";
  // Catches the most common paste mistakes BEFORE Google returns an
  // opaque "invalid_client": truncated IDs, or an API key (AIza...)
  // pasted where the OAuth client ID belongs.
  if (!trimmed.endsWith(".apps.googleusercontent.com")) {
    return "That doesn't look like an OAuth Client ID — it must end with .apps.googleusercontent.com (create one under APIs & Services → Credentials → OAuth client ID → Desktop app)";
  }
  return undefined;
}

export interface GoogleOAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export type GoogleClientSecretParse =
  | { readonly ok: true; readonly credentials: GoogleOAuthClientCredentials }
  | { readonly ok: false; readonly error: string };

/**
 * Parses the `client_secret_*.json` Google offers for download when a client
 * is created. Accepting the file kills the two dominant invalid_client causes
 * at once: a hand-paste that mangles the ID/secret, and pairing a client ID
 * with the secret of a DIFFERENT client. A "web" section means the user
 * created the wrong client type — Muse's loopback flow needs "Desktop app".
 */
export function parseGoogleClientSecretJson(content: string): GoogleClientSecretParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { error: "that isn't valid JSON — download the client_secret_*.json from the client's creation dialog and try again", ok: false };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { error: "unexpected JSON shape — expected the downloaded client_secret_*.json object", ok: false };
  }
  const record = parsed as Record<string, unknown>;
  if (record.web !== undefined) {
    return { error: "this client was created as a \"Web application\" — Muse needs Application type \"Desktop app\". Create a new OAuth client with the right type and download its JSON.", ok: false };
  }
  const installed = record.installed;
  if (installed === null || typeof installed !== "object") {
    return { error: "no \"installed\" section found — is this the client_secret JSON of a Desktop-app OAuth client?", ok: false };
  }
  const fields = installed as Record<string, unknown>;
  const clientId = fields.client_id;
  const clientSecret = fields.client_secret;
  if (typeof clientId !== "string" || !clientId.endsWith(".apps.googleusercontent.com") || typeof clientSecret !== "string" || clientSecret.length === 0) {
    return { error: "client_id / client_secret are missing or malformed in the JSON", ok: false };
  }
  return { credentials: { clientId, clientSecret }, ok: true };
}

/** Distinguishes wizard input: pasted JSON content, a *.json file path, or (undefined) a bare client ID. */
export function looksLikeClientSecretJsonInput(raw: string): "content" | "path" | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return "content";
  if (/\.json$/iu.test(trimmed)) return "path";
  return undefined;
}

export function googlePreflightGuidance(rerunCommand: string): string {
  return `
Google rejected this Client ID before showing any consent screen.
Most common causes, in order:
  - The ID was pasted incompletely (it must end with .apps.googleusercontent.com)
  - The OAuth client was created in a DIFFERENT Google Cloud project
  - The client was deleted, or hasn't been created yet
Fix: open https://console.cloud.google.com/auth/clients (check the project
selector at the top), create an "OAuth client ID" of type "Desktop app",
and re-run \`${rerunCommand}\` with the new ID + secret.
`;
}

export async function preflightGoogleOAuthClient(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
  scope: string = GMAIL_SCOPES
): Promise<GmailClientPreflightResult> {
  // A test that forgets to inject fetch must never probe the real Google
  // endpoint (same hard boundary as the daemon's launchctl seam).
  const underVitest = (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
  if (underVitest && fetchImpl === globalThis.fetch) {
    return { ok: true, skipped: true };
  }
  try {
    const url = new URL(GMAIL_AUTH_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: clientId,
      // Any loopback URI works for the probe: an invalid client errors
      // before redirect_uri validation matters for Desktop clients.
      redirect_uri: "http://127.0.0.1:1/callback",
      response_type: "code",
      scope
    }).toString();
    const response = await fetchImpl(url.toString(), { redirect: "manual" });
    const location = response.headers.get("location") ?? "";
    if (!location.includes("/signin/oauth/error")) return { ok: true };
    const authError = new URL(location).searchParams.get("authError");
    const decoded = authError ? decodeGoogleAuthError(authError) : undefined;
    return {
      ok: false,
      ...(decoded?.code ? { errorCode: decoded.code } : {}),
      ...(decoded?.message ? { message: decoded.message } : {})
    };
  } catch {
    return { ok: true, skipped: true };
  }
}

export interface GmailTokenExchangeResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export interface GmailAccessTokenRefreshResult {
  readonly accessToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

/** Parses `{"error": "..."}` out of a token-endpoint error body; undefined when the body isn't that shape. */
function parseOAuthErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { readonly error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One-shot authorization-code → token exchange (the last step of the setup
 * wizard's loopback flow). Never retried — a failed exchange means the user
 * re-runs the wizard, which mints a fresh code.
 */
export async function exchangeGmailAuthorizationCode(params: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): Promise<GmailTokenExchangeResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const now = params.now ?? Date.now;
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri
  });
  let response: Response;
  try {
    response = await fetchImpl(GMAIL_TOKEN_ENDPOINT, {
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST"
    });
  } catch (cause) {
    throw new Error(`Gmail token exchange failed: network error (${errorMessage(cause)})`, { cause });
  }
  if (!response.ok) {
    const errorCode = parseOAuthErrorCode(await response.text().catch(() => ""));
    // Never echo the response body — Google's OAuth errors don't carry the
    // client secret, but the redaction floor (AC4) applies to every error
    // surface, so only a parsed, allow-listed field ever reaches the message.
    throw new Error(`Gmail token exchange failed (${response.status.toString()}${errorCode ? `: ${errorCode}` : ""})`);
  }
  const payload = await readGoogleTokenPayload(response, "exchange");
  if (!payload.accessToken || !payload.refreshToken) {
    throw new Error("Gmail token exchange response missing access_token/refresh_token — ensure the consent screen requested offline access.");
  }
  return {
    accessToken: payload.accessToken,
    expiresAt: now() + (payload.expiresIn ?? 3600) * 1000,
    refreshToken: payload.refreshToken
  };
}

/** Mints a fresh access token from a stored refresh token. See the class docs above for the invalid_grant / 5xx-network classification. */
export async function refreshGmailAccessToken(params: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): Promise<GmailAccessTokenRefreshResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const now = params.now ?? Date.now;
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken
  });
  let response: Response;
  try {
    response = await fetchImpl(GMAIL_TOKEN_ENDPOINT, {
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST"
    });
  } catch (cause) {
    throw new GmailOAuthRetryableError(`Gmail token refresh failed: network error (${errorMessage(cause)})`, { cause });
  }
  if (response.status >= 500) {
    throw new GmailOAuthRetryableError(`Gmail token refresh failed: server error (${response.status.toString()})`);
  }
  if (!response.ok) {
    const errorCode = parseOAuthErrorCode(await response.text().catch(() => ""));
    if (errorCode === "invalid_grant") {
      throw new GmailOAuthInvalidGrantError("Gmail refresh token is invalid or revoked — run `muse setup email` again. If this happens every ~7 days, your Google app is still in \"Testing\": publish it to Production at https://console.cloud.google.com/auth/audience (personal use needs no review).");
    }
    throw new Error(`Gmail token refresh failed (${response.status.toString()}${errorCode ? `: ${errorCode}` : ""})`);
  }
  const payload = await readGoogleTokenPayload(response, "refresh");
  if (!payload.accessToken) {
    throw new Error("Gmail token refresh response missing access_token");
  }
  return { accessToken: payload.accessToken, expiresAt: now() + (payload.expiresIn ?? 3600) * 1000 };
}

interface GoogleTokenPayload {
  readonly accessToken?: string;
  readonly expiresIn?: number;
  readonly refreshToken?: string;
}

async function readGoogleTokenPayload(response: Response, operation: "exchange" | "refresh"): Promise<GoogleTokenPayload> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new Error(`Gmail token ${operation} response could not be read`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gmail token ${operation} response was not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Gmail token ${operation} response must be a JSON object`);
  }

  const payload = parsed as Record<string, unknown>;
  const expiresIn = payload["expires_in"];
  if (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn < 0)) {
    throw new Error(`Gmail token ${operation} response has invalid expires_in`);
  }
  return {
    ...(typeof payload["access_token"] === "string" ? { accessToken: payload["access_token"] } : {}),
    ...(typeof expiresIn === "number" ? { expiresIn } : {}),
    ...(typeof payload["refresh_token"] === "string" ? { refreshToken: payload["refresh_token"] } : {})
  };
}

export interface GmailTokenSourceDeps {
  readonly io: ProgramIO;
  readonly env: MuseEnvironment;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Builds the `() => Promise<string>` seam `GmailEmailProvider` resolves per
 * request. `MUSE_GMAIL_TOKEN` (explicit override — backcompat/tests/CI)
 * always wins and skips the store entirely. Otherwise: cached access token
 * while it has >60s of life, else refresh-and-persist, single-flight so
 * concurrent callers share one in-flight refresh instead of racing the
 * token endpoint.
 */
export function createGmailTokenSource(deps: GmailTokenSourceDeps): () => Promise<string> {
  let inflight: Promise<string> | undefined;
  return async function getAccessToken(): Promise<string> {
    const envToken = deps.env.MUSE_GMAIL_TOKEN?.trim();
    if (envToken) {
      return envToken;
    }
    if (!inflight) {
      inflight = resolveStoredAccessToken(deps).finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };
}

async function resolveStoredAccessToken(deps: GmailTokenSourceDeps): Promise<string> {
  const now = deps.now ?? Date.now;
  const credential = await readGmailCredential(deps.io);
  if (!credential) {
    throw new GmailNotConfiguredError("No Gmail account connected — run `muse setup email`.");
  }
  if (credential.refreshTokenInvalid) {
    throw new GmailOAuthInvalidGrantError("Gmail refresh token was revoked or expired — run `muse setup email` again. If this happens every ~7 days, your Google app is still in \"Testing\": publish it to Production at https://console.cloud.google.com/auth/audience (personal use needs no review).");
  }
  if (credential.accessToken && credential.accessTokenExpiresAt !== undefined && credential.accessTokenExpiresAt > now() + 60_000) {
    return credential.accessToken;
  }

  let refreshed: GmailAccessTokenRefreshResult;
  try {
    refreshed = await refreshGmailAccessToken({
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      fetchImpl: deps.fetchImpl,
      now,
      refreshToken: credential.refreshToken
    });
  } catch (cause) {
    if (cause instanceof GmailOAuthInvalidGrantError) {
      // Preserve the refresh token for diagnosis; only flip the flag so
      // every subsequent call short-circuits straight to the same typed
      // error instead of re-hitting the token endpoint.
      const marked: GmailOAuthCredential = { ...credential, refreshTokenInvalid: true };
      await writeGmailCredential(deps.io, marked);
    }
    // 5xx/network (GmailOAuthRetryableError) and any other failure: no
    // token-state mutation — the stored credential is untouched so the
    // next call gets a fresh chance.
    throw cause;
  }

  const updated: GmailOAuthCredential = { ...credential, accessToken: refreshed.accessToken, accessTokenExpiresAt: refreshed.expiresAt };
  await writeGmailCredential(deps.io, updated);
  return refreshed.accessToken;
}
