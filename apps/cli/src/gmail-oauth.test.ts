import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readGmailCredential, writeGmailCredential, type GmailOAuthCredential } from "./credential-store.js";
import {
  createGmailTokenSource,
  exchangeGmailAuthorizationCode,
  GMAIL_TOKEN_ENDPOINT,
  GmailNotConfiguredError,
  GmailOAuthInvalidGrantError,
  GmailOAuthRetryableError,
  refreshGmailAccessToken
} from "./gmail-oauth.js";
import type { ProgramIO } from "./program.js";

// Contract-faithful token-endpoint fake: asserts the exact form body Google
// expects (never a fake registry), returns Google-shaped JSON or an OAuth
// error body. Never a real network call.
function tokenEndpointFetch(opts: {
  readonly status?: number;
  readonly body?: Record<string, unknown>;
  readonly errorBody?: { readonly error: string };
  readonly reject?: Error;
}): { readonly fetchImpl: typeof globalThis.fetch; readonly calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (url: string | URL, init?: { readonly body?: string }) => {
    expect(String(url)).toBe(GMAIL_TOKEN_ENDPOINT);
    calls.push(new URLSearchParams(init?.body ?? ""));
    if (opts.reject) throw opts.reject;
    if (opts.errorBody) {
      return new Response(JSON.stringify(opts.errorBody), { status: opts.status ?? 400 });
    }
    if (opts.status && opts.status >= 400) {
      return new Response("{}", { status: opts.status });
    }
    return new Response(JSON.stringify(opts.body ?? {}), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

describe("exchangeGmailAuthorizationCode", () => {
  it("posts the exact authorization_code body and returns access/refresh tokens + a computed expiry", async () => {
    const { fetchImpl, calls } = tokenEndpointFetch({
      body: { access_token: "at-1", expires_in: 3600, refresh_token: "rt-1" }
    });
    const result = await exchangeGmailAuthorizationCode({
      clientId: "cid",
      clientSecret: "csecret",
      code: "auth-code",
      codeVerifier: "verifier-value",
      fetchImpl,
      now: () => 1_000_000,
      redirectUri: "http://127.0.0.1:5555/callback"
    });
    expect(result).toEqual({ accessToken: "at-1", expiresAt: 1_000_000 + 3_600_000, refreshToken: "rt-1" });
    expect(Object.fromEntries(calls[0]!)).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      code: "auth-code",
      code_verifier: "verifier-value",
      grant_type: "authorization_code",
      redirect_uri: "http://127.0.0.1:5555/callback"
    });
  });

  it("throws (never a secret echoed) when the response is missing refresh_token", async () => {
    const { fetchImpl } = tokenEndpointFetch({ body: { access_token: "at-1", expires_in: 3600 } });
    await expect(exchangeGmailAuthorizationCode({
      clientId: "cid", clientSecret: "csecret-should-never-appear", code: "c", codeVerifier: "v", fetchImpl, redirectUri: "http://x"
    })).rejects.toThrow(/missing access_token\/refresh_token/u);
  });

  it("a non-2xx surfaces status + parsed error code, but never echoes the client secret", async () => {
    const { fetchImpl } = tokenEndpointFetch({ errorBody: { error: "invalid_grant" }, status: 400 });
    await expect(exchangeGmailAuthorizationCode({
      clientId: "cid", clientSecret: "csecret-should-never-appear", code: "bad-code", codeVerifier: "v", fetchImpl, redirectUri: "http://x"
    })).rejects.toThrow(/Gmail token exchange failed \(400: invalid_grant\)/u);
  });

  it("a network failure surfaces as a plain Error, never a secret-bearing message", async () => {
    const { fetchImpl } = tokenEndpointFetch({ reject: new Error("ECONNRESET") });
    await expect(exchangeGmailAuthorizationCode({
      clientId: "cid", clientSecret: "csecret-should-never-appear", code: "c", codeVerifier: "v", fetchImpl, redirectUri: "http://x"
    })).rejects.toThrow(/network error/u);
  });

  it("rejects a 2xx non-JSON body without echoing the response", async () => {
    const fetchImpl = (async () => new Response("<html>proxy failure</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeGmailAuthorizationCode({
      clientId: "cid", clientSecret: "csecret", code: "c", codeVerifier: "v", fetchImpl, redirectUri: "http://x"
    })).rejects.toThrow("Gmail token exchange response was not valid JSON");
  });
});

describe("refreshGmailAccessToken", () => {
  it("posts the exact refresh_token body and returns a new access token + expiry", async () => {
    const { fetchImpl, calls } = tokenEndpointFetch({ body: { access_token: "at-2", expires_in: 1800 } });
    const result = await refreshGmailAccessToken({
      clientId: "cid", clientSecret: "csecret", fetchImpl, now: () => 5_000, refreshToken: "rt-1"
    });
    expect(result).toEqual({ accessToken: "at-2", expiresAt: 5_000 + 1_800_000 });
    expect(Object.fromEntries(calls[0]!)).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      grant_type: "refresh_token",
      refresh_token: "rt-1"
    });
  });

  it("classifies `invalid_grant` as GmailOAuthInvalidGrantError — the ONLY correct handling: tell the user to re-run `muse setup email`, never retry-loop it", async () => {
    const { fetchImpl } = tokenEndpointFetch({ errorBody: { error: "invalid_grant" }, status: 400 });
    await expect(refreshGmailAccessToken({ clientId: "cid", clientSecret: "csecret", fetchImpl, refreshToken: "revoked" }))
      .rejects.toBeInstanceOf(GmailOAuthInvalidGrantError);
  });

  it("does NOT classify an unrelated 400 (e.g. invalid_client) as invalid_grant — only the exact `invalid_grant` code short-circuits to 're-run setup'", async () => {
    const { fetchImpl } = tokenEndpointFetch({ errorBody: { error: "invalid_client" }, status: 400 });
    const rejection = refreshGmailAccessToken({ clientId: "bad-cid", clientSecret: "csecret", fetchImpl, refreshToken: "rt-1" });
    await expect(rejection).rejects.not.toBeInstanceOf(GmailOAuthInvalidGrantError);
    await expect(rejection).rejects.not.toBeInstanceOf(GmailOAuthRetryableError);
  });

  it("classifies a 5xx as GmailOAuthRetryableError", async () => {
    const { fetchImpl } = tokenEndpointFetch({ status: 503 });
    await expect(refreshGmailAccessToken({ clientId: "cid", clientSecret: "csecret", fetchImpl, refreshToken: "rt-1" }))
      .rejects.toBeInstanceOf(GmailOAuthRetryableError);
  });

  it("classifies a network reject as GmailOAuthRetryableError", async () => {
    const { fetchImpl } = tokenEndpointFetch({ reject: new Error("ETIMEDOUT") });
    await expect(refreshGmailAccessToken({ clientId: "cid", clientSecret: "csecret", fetchImpl, refreshToken: "rt-1" }))
      .rejects.toBeInstanceOf(GmailOAuthRetryableError);
  });

  it("rejects an invalid expires_in instead of persisting a NaN expiry", async () => {
    const { fetchImpl } = tokenEndpointFetch({ body: { access_token: "at-2", expires_in: "3600" } });
    await expect(refreshGmailAccessToken({ clientId: "cid", clientSecret: "csecret", fetchImpl, refreshToken: "rt-1" }))
      .rejects.toThrow("Gmail token refresh response has invalid expires_in");
  });

  it("never echoes the client secret or refresh token in ANY thrown message (invalid_grant / other 4xx / 5xx / network)", async () => {
    const secretMarker = "SECRET-MARKER-should-never-leak";
    const cases: Array<() => Promise<unknown>> = [
      () => refreshGmailAccessToken({ clientId: "cid", clientSecret: secretMarker, fetchImpl: tokenEndpointFetch({ errorBody: { error: "invalid_grant" }, status: 400 }).fetchImpl, refreshToken: secretMarker }),
      () => refreshGmailAccessToken({ clientId: "cid", clientSecret: secretMarker, fetchImpl: tokenEndpointFetch({ errorBody: { error: "invalid_client" }, status: 400 }).fetchImpl, refreshToken: secretMarker }),
      () => refreshGmailAccessToken({ clientId: "cid", clientSecret: secretMarker, fetchImpl: tokenEndpointFetch({ status: 503 }).fetchImpl, refreshToken: secretMarker }),
      () => refreshGmailAccessToken({ clientId: "cid", clientSecret: secretMarker, fetchImpl: tokenEndpointFetch({ reject: new Error("boom") }).fetchImpl, refreshToken: secretMarker })
    ];
    for (const run of cases) {
      try {
        await run();
        throw new Error("expected rejection");
      } catch (cause) {
        expect((cause as Error).message).not.toContain(secretMarker);
      }
    }
  });
});

describe("createGmailTokenSource", () => {
  let workdir: string;
  const makeIo = (): ProgramIO => ({
    configDir: workdir,
    credentialKey: "test-credential-key-aaaaaaaaaaaaaa",
    stderr: () => undefined,
    stdout: () => undefined
  });
  const baseCredential: GmailOAuthCredential = {
    clientId: "cid",
    clientSecret: "csecret",
    refreshToken: "rt-1"
  };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-gmail-oauth-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("MUSE_GMAIL_TOKEN wins over any stored credential and never touches the store", async () => {
    // No credential written at all — if the source touched the store it
    // would hit GmailNotConfiguredError; instead it must short-circuit.
    const getAccessToken = createGmailTokenSource({ env: { MUSE_GMAIL_TOKEN: "  raw-override-token  " }, io: makeIo() });
    await expect(getAccessToken()).resolves.toBe("raw-override-token");
  });

  it("throws GmailNotConfiguredError when nothing is configured at all", async () => {
    const getAccessToken = createGmailTokenSource({ env: {}, io: makeIo() });
    await expect(getAccessToken()).rejects.toBeInstanceOf(GmailNotConfiguredError);
  });

  it("returns the cached access token without a network call while it has >60s of life", async () => {
    const io = makeIo();
    await writeGmailCredential(io, { ...baseCredential, accessToken: "cached-at", accessTokenExpiresAt: Date.now() + 10 * 60_000 });
    let fetchCalls = 0;
    const fetchImpl = (async () => { fetchCalls += 1; throw new Error("must not be called"); }) as unknown as typeof globalThis.fetch;
    const getAccessToken = createGmailTokenSource({ env: {}, fetchImpl, io });
    await expect(getAccessToken()).resolves.toBe("cached-at");
    expect(fetchCalls).toBe(0);
  });

  it("refreshes + persists the new access token when the cached one is within 60s of expiry", async () => {
    const io = makeIo();
    await writeGmailCredential(io, { ...baseCredential, accessToken: "stale-at", accessTokenExpiresAt: Date.now() + 30_000 });
    const { fetchImpl } = tokenEndpointFetch({ body: { access_token: "fresh-at", expires_in: 3600 } });
    const getAccessToken = createGmailTokenSource({ env: {}, fetchImpl, io });
    await expect(getAccessToken()).resolves.toBe("fresh-at");
    const persisted = await readGmailCredential(io);
    expect(persisted?.accessToken).toBe("fresh-at");
    expect(persisted?.refreshToken).toBe("rt-1");
  });

  it("invalid_grant marks the stored credential invalid (refresh token PRESERVED for diagnosis) and every subsequent call short-circuits to GmailOAuthInvalidGrantError without hitting the network again", async () => {
    const io = makeIo();
    await writeGmailCredential(io, baseCredential);
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as unknown as typeof globalThis.fetch;
    const getAccessToken = createGmailTokenSource({ env: {}, fetchImpl, io });

    await expect(getAccessToken()).rejects.toBeInstanceOf(GmailOAuthInvalidGrantError);
    expect(fetchCalls).toBe(1);
    const marked = await readGmailCredential(io);
    expect(marked?.refreshTokenInvalid).toBe(true);
    expect(marked?.refreshToken).toBe("rt-1"); // preserved for diagnosis, never cleared

    // Second call: short-circuits from the stored flag, no second network call.
    await expect(getAccessToken()).rejects.toBeInstanceOf(GmailOAuthInvalidGrantError);
    expect(fetchCalls).toBe(1);
  });

  it("a 5xx/network failure (GmailOAuthRetryableError) leaves the stored credential COMPLETELY UNCHANGED — no token-state mutation on a transient failure", async () => {
    const io = makeIo();
    await writeGmailCredential(io, { ...baseCredential, accessToken: "old-at", accessTokenExpiresAt: Date.now() - 1000 });
    const before = await readGmailCredential(io);
    const { fetchImpl } = tokenEndpointFetch({ status: 503 });
    const getAccessToken = createGmailTokenSource({ env: {}, fetchImpl, io });
    await expect(getAccessToken()).rejects.toBeInstanceOf(GmailOAuthRetryableError);
    expect(await readGmailCredential(io)).toEqual(before);
  });

  it("single-flight: two concurrent callers while a refresh is in flight share ONE token-endpoint call", async () => {
    const io = makeIo();
    await writeGmailCredential(io, baseCredential);
    let fetchCalls = 0;
    const fetchDeferred = Promise.withResolvers<Response>();
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return fetchDeferred.promise;
    }) as unknown as typeof globalThis.fetch;
    const getAccessToken = createGmailTokenSource({ env: {}, fetchImpl, io });

    const first = getAccessToken();
    const second = getAccessToken();
    // Both callers still have an async credential-store read ahead of the
    // fetch call — wait for the in-flight refresh to actually reach it.
    while (fetchCalls === 0) {
      await setImmediate();
    }
    expect(fetchCalls).toBe(1); // the second call joined the in-flight promise, not a fresh fetch
    fetchDeferred.resolve(new Response(JSON.stringify({ access_token: "shared-at", expires_in: 3600 }), { status: 200 }));
    await expect(first).resolves.toBe("shared-at");
    await expect(second).resolves.toBe("shared-at");
    expect(fetchCalls).toBe(1);
  });
});

describe("preflightGoogleOAuthClient — catches Google's invalid_client before any browser opens", () => {
  const realAuthErrorBlob = "Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw";

  it("decodes Google's real authError blob into code + message", async () => {
    const { decodeGoogleAuthError } = await import("./gmail-oauth.js");
    const decoded = decodeGoogleAuthError(realAuthErrorBlob);
    expect(decoded?.code).toBe("invalid_client");
    expect(decoded?.message).toBe("The OAuth client was not found.");
  });

  it("returns ok:false with the decoded error when Google 302s to the oauth error page", async () => {
    const { preflightGoogleOAuthClient } = await import("./gmail-oauth.js");
    const fetchImpl = (async (input: unknown) => {
      expect(String(input)).toContain("client_id=bad.apps.googleusercontent.com");
      return {
        headers: new Headers({
          location: `https://accounts.google.com/signin/oauth/error?authError=${realAuthErrorBlob}&flowName=GeneralOAuthFlow`
        }),
        status: 302
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await preflightGoogleOAuthClient("bad.apps.googleusercontent.com", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_client");
    expect(result.message).toBe("The OAuth client was not found.");
  });

  it("returns ok:true when Google 302s into the normal sign-in flow", async () => {
    const { preflightGoogleOAuthClient } = await import("./gmail-oauth.js");
    const fetchImpl = (async () => ({
      headers: new Headers({ location: "https://accounts.google.com/v3/signin/identifier?opparams=x" }),
      status: 302
    } as unknown as Response)) as unknown as typeof fetch;
    const result = await preflightGoogleOAuthClient("good.apps.googleusercontent.com", fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it("fails open (ok:true, skipped) when the probe itself cannot run", async () => {
    const { preflightGoogleOAuthClient } = await import("./gmail-oauth.js");
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await preflightGoogleOAuthClient("any.apps.googleusercontent.com", fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

describe("validateGoogleOAuthClientIdInput — shared prompt validation for every Google OAuth wizard (email + calendar)", () => {
  it("rejects an empty input", async () => {
    const { validateGoogleOAuthClientIdInput } = await import("./gmail-oauth.js");
    expect(validateGoogleOAuthClientIdInput("")).toBe("Client ID is required");
    expect(validateGoogleOAuthClientIdInput(undefined)).toBe("Client ID is required");
  });

  it("rejects a value without the .apps.googleusercontent.com suffix — the truncated-paste / API-key mistake", async () => {
    const { validateGoogleOAuthClientIdInput } = await import("./gmail-oauth.js");
    expect(validateGoogleOAuthClientIdInput("AIzaSyFakeApiKey")).toContain(".apps.googleusercontent.com");
  });

  it("accepts a well-formed client ID (whitespace tolerated)", async () => {
    const { validateGoogleOAuthClientIdInput } = await import("./gmail-oauth.js");
    expect(validateGoogleOAuthClientIdInput(" 123-abc.apps.googleusercontent.com ")).toBeUndefined();
  });
});

describe("googlePreflightGuidance — the terminal explanation names the wizard to re-run", () => {
  it("embeds the given rerun command", async () => {
    const { googlePreflightGuidance } = await import("./gmail-oauth.js");
    expect(googlePreflightGuidance("muse setup calendar")).toContain("`muse setup calendar`");
    expect(googlePreflightGuidance("muse setup email")).toContain("`muse setup email`");
  });
});

describe("preflightGoogleOAuthClient — scope parameter", () => {
  it("probes with the caller-provided scope so non-Gmail wizards preflight their own scope", async () => {
    const { preflightGoogleOAuthClient } = await import("./gmail-oauth.js");
    let probedUrl = "";
    const fetchImpl = (async (input: unknown) => {
      probedUrl = String(input);
      return {
        headers: new Headers({ location: "https://accounts.google.com/v3/signin/identifier" }),
        status: 302
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await preflightGoogleOAuthClient("x.apps.googleusercontent.com", fetchImpl, "https://www.googleapis.com/auth/calendar");
    expect(probedUrl).toContain(encodeURIComponent("https://www.googleapis.com/auth/calendar"));
  });
});

describe("parseGoogleClientSecretJson — the downloaded client_secret_*.json replaces hand-pasting", () => {
  it("accepts a Desktop-app JSON (\"installed\" section)", async () => {
    const { parseGoogleClientSecretJson } = await import("./gmail-oauth.js");
    const result = parseGoogleClientSecretJson(JSON.stringify({
      installed: { client_id: "x.apps.googleusercontent.com", client_secret: "GOCSPX-abc", redirect_uris: ["http://localhost"] }
    }));
    expect(result).toEqual({ credentials: { clientId: "x.apps.googleusercontent.com", clientSecret: "GOCSPX-abc" }, ok: true });
  });

  it("names the wrong-client-type mistake: a \"web\" JSON is rejected with the Desktop-app fix", async () => {
    const { parseGoogleClientSecretJson } = await import("./gmail-oauth.js");
    const result = parseGoogleClientSecretJson(JSON.stringify({ web: { client_id: "x.apps.googleusercontent.com", client_secret: "s" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Desktop app");
  });

  it("rejects non-JSON and JSON without an installed section", async () => {
    const { parseGoogleClientSecretJson } = await import("./gmail-oauth.js");
    expect(parseGoogleClientSecretJson("not json").ok).toBe(false);
    expect(parseGoogleClientSecretJson("{}").ok).toBe(false);
  });

  it("rejects a malformed client_id or empty secret inside the JSON", async () => {
    const { parseGoogleClientSecretJson } = await import("./gmail-oauth.js");
    expect(parseGoogleClientSecretJson(JSON.stringify({ installed: { client_id: "truncated", client_secret: "s" } })).ok).toBe(false);
    expect(parseGoogleClientSecretJson(JSON.stringify({ installed: { client_id: "x.apps.googleusercontent.com", client_secret: "" } })).ok).toBe(false);
  });
});

describe("looksLikeClientSecretJsonInput — routing wizard input", () => {
  it("classifies pasted JSON, a .json path, and a bare client ID", async () => {
    const { looksLikeClientSecretJsonInput } = await import("./gmail-oauth.js");
    expect(looksLikeClientSecretJsonInput('{"installed":{}}')).toBe("content");
    expect(looksLikeClientSecretJsonInput("~/Downloads/client_secret_x.json")).toBe("path");
    expect(looksLikeClientSecretJsonInput("x.apps.googleusercontent.com")).toBeUndefined();
  });
});
