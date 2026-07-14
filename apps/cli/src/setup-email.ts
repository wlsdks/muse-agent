/**
 * `muse setup email` — guided Gmail OAuth wizard (loopback + PKCE), so a
 * non-developer runs this ONCE and `muse email` / `muse inbox` / the daemon
 * email-sync tick keep working forever, refreshing their own access token
 * (gmail-oauth.ts) instead of the old raw-1-hour-token dead end.
 *
 * Split for testability (AC3: "unit tests with an injected fake browser
 * opener + fake token endpoint, never a real network call"):
 * `runGmailOAuthLoopback` is the non-interactive PKCE/state/callback-server/
 * code-exchange dance (fully fake-injectable); `runEmailSetup` adds the
 * clack prompts + credential-store write + connectivity proof around it.
 *
 * Deliberately does NOT gate on MUSE_LOCAL_ONLY: Gmail is the user's own
 * data plane (not an LLM call), so wiring it up is allowed regardless of
 * local-only posture (unlike setup-calendar.ts / setup-messaging.ts, which
 * DO refuse — those wire genuinely remote services the local-only posture
 * is about). `muse doctor`'s email-auth check carries the same note.
 */

import { spawn } from "node:child_process";

import { password, text, isCancel } from "@clack/prompts";
import { startOAuthCallbackServer, type OAuthCallbackServer } from "@muse/mcp";

import { writeGmailCredential, type GmailOAuthCredential } from "./credential-store.js";
import { generateOAuthState, generatePkcePair } from "./setup-calendar.js";
import { exchangeGmailAuthorizationCode, GMAIL_AUTH_ENDPOINT, GMAIL_SCOPES, preflightGmailClient, type GmailClientPreflightResult, type GmailTokenExchangeResult } from "./gmail-oauth.js";
import type { ProgramIO } from "./program.js";

const WALKTHROUGH = `
Gmail setup — one-time browser consent, then it refreshes itself forever.

  1. Open https://console.cloud.google.com/apis/library/gmail.googleapis.com
     (create a project first if you don't have one) and click "Enable".
  2. Open the Google Auth Platform: https://console.cloud.google.com/auth/overview
     First time: click "Get started" and fill in the app name + your email
     (this is the consent-screen "Branding" step). Choose "External".
  3. Add yourself as a test user:
     https://console.cloud.google.com/auth/audience → "Test users" → + Add users.
  4. Create the client: https://console.cloud.google.com/auth/clients
     "+ Create client" → Application type "Desktop app".
  5. Copy the Client ID (ends in .apps.googleusercontent.com) AND the Client
     Secret from the creation dialog — paste them below.

  ⚠️  Google shows the Client Secret ONLY ONCE, in that creation dialog.
      If you closed it, create a new client — the secret is not viewable later.
  ⚠️  While the app's publishing status is "Testing", Google expires your
      refresh token every 7 days (you'll re-run this wizard weekly). Publish
      to "Production" on https://console.cloud.google.com/auth/audience to
      avoid that — for personal use no verification review is needed.

`;

const PREFLIGHT_GUIDANCE = `
Google rejected this Client ID before showing any consent screen.
Most common causes, in order:
  - The ID was pasted incompletely (it must end with .apps.googleusercontent.com)
  - The OAuth client was created in a DIFFERENT Google Cloud project
  - The client was deleted, or hasn't been created yet
Fix: open https://console.cloud.google.com/auth/clients (check the project
selector at the top), create an "OAuth client ID" of type "Desktop app",
and re-run \`muse setup email\` with the new ID + secret.
`;

export interface GmailOAuthLoopbackDeps {
  readonly stdout: (message: string) => void;
  readonly openBrowser?: (url: string) => Promise<void> | void;
  readonly preflightClient?: (clientId: string, fetchImpl: typeof fetch) => Promise<GmailClientPreflightResult>;
  readonly startCallbackServer?: (options: { readonly expectedState: string; readonly timeoutMs: number }) => Promise<OAuthCallbackServer>;
  readonly exchangeCode?: typeof exchangeGmailAuthorizationCode;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Default 5 minutes. */
  readonly timeoutMs?: number;
}

export type GmailOAuthLoopbackResult =
  | { readonly ok: true; readonly credential: GmailOAuthCredential }
  | { readonly ok: false; readonly reason: string };

/**
 * The non-interactive half: bind the loopback callback server, print +
 * (best-effort) open the authorization URL, wait for the redirect, exchange
 * the code. State-mismatch / timeout / missing-code are all surfaced by
 * `startOAuthCallbackServer` itself (never resolves a code in those cases —
 * see its own CSRF-guard docs) and turn into `{ ok: false }` here, with
 * NOTHING written to the credential store (the caller only persists on
 * `ok: true`).
 */
export async function runGmailOAuthLoopback(params: {
  readonly clientId: string;
  readonly clientSecret: string;
} & GmailOAuthLoopbackDeps): Promise<GmailOAuthLoopbackResult> {
  const startCallbackServer = params.startCallbackServer ?? startOAuthCallbackServer;
  const exchangeCode = params.exchangeCode ?? exchangeGmailAuthorizationCode;
  const timeoutMs = params.timeoutMs ?? 5 * 60_000;
  const state = generateOAuthState();
  const pkce = generatePkcePair();

  const preflight = await (params.preflightClient ?? preflightGmailClient)(
    params.clientId,
    params.fetchImpl ?? globalThis.fetch
  );
  if (!preflight.ok) {
    params.stdout(PREFLIGHT_GUIDANCE);
    const detail = [preflight.errorCode, preflight.message].filter(Boolean).join(": ");
    return { ok: false, reason: `Google rejected the OAuth client before consent${detail ? ` (${detail})` : ""}` };
  }

  const callback = await startCallbackServer({ expectedState: state, timeoutMs });
  try {
    const redirectUri = `http://127.0.0.1:${callback.port.toString()}/callback`;
    const authUrl = new URL(GMAIL_AUTH_ENDPOINT);
    authUrl.search = new URLSearchParams({
      access_type: "offline",
      client_id: params.clientId,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
      // Forces Google to re-issue a refresh_token even on a repeat consent
      // for the same client — without it, a second `muse setup email` run
      // can come back with no refresh_token at all.
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GMAIL_SCOPES,
      state
    }).toString();

    params.stdout(`Open this URL to authorize Gmail access:\n  ${authUrl.toString()}\n\nWaiting for the browser redirect on ${redirectUri} ...\n`);
    if (params.openBrowser) {
      try {
        await params.openBrowser(authUrl.toString());
      } catch {
        // Non-blocking open step.
      }
    }

    let code: string;
    try {
      ({ code } = await callback.waitForCode());
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }

    let exchanged: GmailTokenExchangeResult;
    try {
      exchanged = await exchangeCode({
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        code,
        codeVerifier: pkce.verifier,
        fetchImpl: params.fetchImpl,
        now: params.now,
        redirectUri
      });
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }

    return {
      credential: {
        accessToken: exchanged.accessToken,
        accessTokenExpiresAt: exchanged.expiresAt,
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        refreshToken: exchanged.refreshToken
      },
      ok: true
    };
  } finally {
    await callback.close();
  }
}

async function defaultPromptClientId(): Promise<string | undefined> {
  const value = await text({
    message: "Google OAuth Client ID:",
    placeholder: "xxx.apps.googleusercontent.com",
    validate: (input) => {
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
  });
  return isCancel(value) || typeof value !== "string" || value.trim().length === 0 ? undefined : value.trim();
}

async function defaultPromptClientSecret(): Promise<string | undefined> {
  const value = await password({ message: "Google OAuth Client Secret:" });
  return isCancel(value) || typeof value !== "string" || value.length === 0 ? undefined : value;
}

/** macOS `open` best-effort; every other platform falls back to the printed URL (runGmailOAuthLoopback always prints it). */
function defaultOpenBrowser(url: string): void {
  if (process.platform !== "darwin") return;
  try {
    spawn("open", [url], { stdio: "ignore" }).on("error", () => undefined);
  } catch { /* best-effort — the printed URL is the real fallback */ }
}

async function defaultVerifyGmailProfile(accessToken: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { readonly emailAddress?: string };
    return payload.emailAddress;
  } catch {
    return undefined;
  }
}

export interface SetupEmailIO extends ProgramIO {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface SetupEmailDeps extends GmailOAuthLoopbackDeps {
  readonly promptClientId?: () => Promise<string | undefined>;
  readonly promptClientSecret?: () => Promise<string | undefined>;
  readonly verifyProfile?: (accessToken: string, fetchImpl: typeof fetch) => Promise<string | undefined>;
}

export interface SetupEmailResult {
  readonly ok: boolean;
}

export async function runEmailSetup(io: SetupEmailIO, deps: Partial<SetupEmailDeps> = {}): Promise<SetupEmailResult> {
  io.stdout(WALKTHROUGH);

  const clientId = await (deps.promptClientId ?? defaultPromptClientId)();
  if (!clientId) {
    io.stdout("Setup cancelled.\n");
    return { ok: false };
  }
  const clientSecret = await (deps.promptClientSecret ?? defaultPromptClientSecret)();
  if (!clientSecret) {
    io.stdout("Setup cancelled.\n");
    return { ok: false };
  }

  const fetchImpl = deps.fetchImpl ?? io.fetch ?? globalThis.fetch;
  const result = await runGmailOAuthLoopback({
    clientId,
    clientSecret,
    exchangeCode: deps.exchangeCode,
    fetchImpl,
    now: deps.now,
    openBrowser: deps.openBrowser ?? defaultOpenBrowser,
    startCallbackServer: deps.startCallbackServer,
    stdout: io.stdout,
    timeoutMs: deps.timeoutMs
  });

  if (!result.ok) {
    io.stderr(`muse setup email: authorization failed — ${result.reason}\n`);
    return { ok: false };
  }

  await writeGmailCredential(io, result.credential);
  io.stdout("✓ Gmail connected — the access token now refreshes itself automatically.\n");

  const verifyProfile = deps.verifyProfile ?? defaultVerifyGmailProfile;
  const emailAddress = result.credential.accessToken ? await verifyProfile(result.credential.accessToken, fetchImpl) : undefined;
  if (emailAddress) {
    io.stdout(`✓ connected as ${emailAddress}\n`);
  } else {
    io.stderr("(saved, but couldn't verify with a live Gmail profile read — try `muse inbox` or `muse doctor` to confirm.)\n");
  }

  return { ok: true };
}
