/**
 * `muse setup email` — asks the connection method first, then runs one of
 * two wizards:
 *
 *   1. App Password (RECOMMENDED) — email + a Gmail/IMAP-provider app
 *      password, immediate real-IMAP verification, done in ~2 minutes. No
 *      Google Cloud project (hermes-agent's approach; works for Gmail and
 *      any other IMAP provider by supplying host overrides).
 *   2. Google OAuth (loopback + PKCE) — the original flow, UNCHANGED, for
 *      when a refresh-token-based integration is preferred.
 *
 * Split for testability (AC3: "unit tests with injected prompts + an
 * injected verifier, never a real network call"): `runGmailOAuthLoopback`
 * is the non-interactive PKCE/state/callback-server/code-exchange dance;
 * `runAppPasswordEmailSetup` is the App Password prompt+verify+store
 * sequence; `runEmailSetup` is the method-selecting entrypoint both live
 * behind.
 *
 * Deliberately does NOT gate on MUSE_LOCAL_ONLY: email is the user's own
 * data plane (not an LLM call), so wiring it up is allowed regardless of
 * local-only posture (unlike setup-calendar.ts / setup-messaging.ts, which
 * DO refuse — those wire genuinely remote services the local-only posture
 * is about). `muse doctor`'s email-auth check carries the same note.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { isRecord } from "@muse/shared";
import { password, select, text, isCancel } from "@clack/prompts";
import { ImapSmtpEmailProvider, type ImapSmtpEmailProviderConfig } from "@muse/domain-tools";
import { startOAuthCallbackServer, type OAuthCallbackServer } from "@muse/mcp";

import { writeEmailImapCredential, writeGmailCredential, type GmailOAuthCredential, type ImapEmailCredential } from "./credential-store.js";
import { generateOAuthState, generatePkcePair } from "./setup-calendar.js";
import { exchangeGmailAuthorizationCode, GMAIL_AUTH_ENDPOINT, GMAIL_SCOPES, googlePreflightGuidance, looksLikeClientSecretJsonInput, parseGoogleClientSecretJson, preflightGoogleOAuthClient, validateGoogleOAuthClientIdInput, type GmailClientPreflightResult, type GmailTokenExchangeResult } from "./gmail-oauth.js";
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
  5. EASIEST: click ⬇ in the creation dialog to download the
     client_secret_*.json and paste that file's PATH below — Muse reads the
     ID + secret from it, so nothing can be mis-pasted or mismatched.
     (Or copy the Client ID and Client Secret by hand as before.)

  ⚠️  Google shows the Client Secret ONLY ONCE, in that creation dialog.
      If you closed it, create a new client — the secret is not viewable later.
  ⚠️  While the app's publishing status is "Testing", Google expires your
      refresh token every 7 days (you'll re-run this wizard weekly). Publish
      to "Production" on https://console.cloud.google.com/auth/audience to
      avoid that — for personal use no verification review is needed.

`;

const PREFLIGHT_GUIDANCE = googlePreflightGuidance("muse setup email");

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

  const preflight = await (params.preflightClient ?? preflightGoogleOAuthClient)(
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
    message: "Google OAuth Client ID (or path to the downloaded client_secret_*.json):",
    placeholder: "xxx.apps.googleusercontent.com  ·  ~/Downloads/client_secret_xxx.json",
    validate: (input) => looksLikeClientSecretJsonInput(input ?? "") ? undefined : validateGoogleOAuthClientIdInput(input)
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
    const payload = await response.json();
    return isRecord(payload) && typeof payload.emailAddress === "string" ? payload.emailAddress : undefined;
  } catch {
    return undefined;
  }
}

export interface SetupEmailIO extends ProgramIO {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type EmailSetupMethod = "apppassword" | "oauth";

export type ImapVerifyOutcome =
  | { readonly ok: true; readonly messageCount: number }
  | { readonly ok: false; readonly error: Error };

export interface AppPasswordSetupDeps {
  readonly promptEmail?: () => Promise<string | undefined>;
  readonly promptAppPassword?: () => Promise<string | undefined>;
  readonly promptImapHost?: () => Promise<string | undefined>;
  readonly promptSmtpHost?: () => Promise<string | undefined>;
  /** Real IMAP login + mailbox open, injectable so tests never touch a socket. */
  readonly verifyImapConnection?: (config: ImapSmtpEmailProviderConfig) => Promise<ImapVerifyOutcome>;
}

export interface SetupEmailDeps extends GmailOAuthLoopbackDeps, AppPasswordSetupDeps {
  readonly promptMethod?: () => Promise<EmailSetupMethod | undefined>;
  readonly promptClientId?: () => Promise<string | undefined>;
  readonly promptClientSecret?: () => Promise<string | undefined>;
  readonly readFileImpl?: (path: string) => Promise<string>;
  readonly verifyProfile?: (accessToken: string, fetchImpl: typeof fetch) => Promise<string | undefined>;
}

export interface SetupEmailResult {
  readonly ok: boolean;
}

async function defaultPromptMethod(): Promise<EmailSetupMethod | undefined> {
  const value = await select({
    message: "How do you want to connect email?",
    options: [
      { hint: "2 minutes, Gmail or any other IMAP provider — no Google Cloud project", label: "App Password (recommended)", value: "apppassword" as const },
      { hint: "existing flow — needs a Google Cloud project + OAuth client", label: "Google OAuth", value: "oauth" as const }
    ]
  });
  return isCancel(value) ? undefined : value;
}

export async function runEmailSetup(io: SetupEmailIO, deps: Partial<SetupEmailDeps> = {}): Promise<SetupEmailResult> {
  const method = await (deps.promptMethod ?? defaultPromptMethod)();
  if (!method) {
    io.stdout("Setup cancelled.\n");
    return { ok: false };
  }
  if (method === "apppassword") {
    return runAppPasswordEmailSetup(io, deps);
  }
  return runOAuthEmailSetup(io, deps);
}

const APP_PASSWORD_WALKTHROUGH = `
App Password setup — about 2 minutes, no Google Cloud project needed.

  Google:
  1. Turn on 2-Step Verification (if it isn't already):
     https://myaccount.google.com/signinoptions/two-step-verification
  2. Generate a 16-character App Password:
     https://myaccount.google.com/apppasswords
  3. Paste the 16 characters below — Google shows them with spaces
     ("abcd efgh ijkl mnop"); spaces are stripped automatically.

  Any other provider (Naver, Daum, ...): check that provider's mail
  settings / security page for its own IMAP/app-password option, then
  answer the IMAP/SMTP host prompts below.

`;

/** `email@gmail.com` (case-insensitive) — the only address family that gets Gmail's IMAP/SMTP hosts by default. */
function isGmailAddress(email: string): boolean {
  return /@gmail\.com$/iu.test(email.trim());
}

async function defaultPromptEmail(): Promise<string | undefined> {
  const value = await text({
    message: "Email address:",
    placeholder: "you@gmail.com",
    validate: (input) => {
      const trimmed = (input ?? "").trim();
      if (trimmed.length === 0) return "Email is required";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) return "That doesn't look like a valid email address";
      return undefined;
    }
  });
  return isCancel(value) || typeof value !== "string" || value.trim().length === 0 ? undefined : value.trim();
}

async function defaultPromptAppPassword(): Promise<string | undefined> {
  const value = await password({
    message: "App password (spaces are fine — they're stripped):",
    validate: (input) => ((input ?? "").replace(/\s+/gu, "").length === 0 ? "App password is required" : undefined)
  });
  if (isCancel(value) || typeof value !== "string") return undefined;
  const stripped = value.replace(/\s+/gu, "");
  return stripped.length > 0 ? stripped : undefined;
}

async function defaultPromptHost(label: string): Promise<string | undefined> {
  const value = await text({ message: `${label} host (leave blank to use the provider default):`, placeholder: `${label.toLowerCase()}.example.com` });
  return isCancel(value) || typeof value !== "string" || value.trim().length === 0 ? undefined : value.trim();
}

async function defaultVerifyImapConnection(config: ImapSmtpEmailProviderConfig): Promise<ImapVerifyOutcome> {
  try {
    const { messageCount } = await new ImapSmtpEmailProvider(config).verifyConnection();
    return { messageCount, ok: true };
  } catch (cause) {
    return { error: cause instanceof Error ? cause : new Error(String(cause)), ok: false };
  }
}

export async function runAppPasswordEmailSetup(io: SetupEmailIO, deps: Partial<AppPasswordSetupDeps> = {}): Promise<SetupEmailResult> {
  io.stdout(APP_PASSWORD_WALKTHROUGH);

  const email = await (deps.promptEmail ?? defaultPromptEmail)();
  if (!email) {
    io.stdout("Setup cancelled.\n");
    return { ok: false };
  }
  const rawAppPassword = await (deps.promptAppPassword ?? defaultPromptAppPassword)();
  // Spaces stripped unconditionally here (not just in the default prompt) —
  // Google always displays the 16 characters with spaces, and a pasted
  // value must be normalised the same way whether the prompt is real or
  // injected by a test.
  const appPassword = rawAppPassword?.replace(/\s+/gu, "");
  if (!appPassword) {
    io.stdout("Setup cancelled.\n");
    return { ok: false };
  }

  let imapHost: string | undefined;
  let smtpHost: string | undefined;
  if (!isGmailAddress(email)) {
    imapHost = await (deps.promptImapHost ?? (() => defaultPromptHost("IMAP")))();
    smtpHost = await (deps.promptSmtpHost ?? (() => defaultPromptHost("SMTP")))();
  }

  const credential: ImapEmailCredential = {
    appPassword,
    email,
    ...(imapHost ? { imapHost } : {}),
    ...(smtpHost ? { smtpHost } : {})
  };

  const verify = deps.verifyImapConnection ?? defaultVerifyImapConnection;
  const verified = await verify(credential);
  if (!verified.ok) {
    io.stderr(`muse setup email: could not connect — ${verified.error.message}\n`);
    return { ok: false };
  }

  await writeEmailImapCredential(io, credential);
  io.stdout(`✓ connected — inbox has ${verified.messageCount.toString()} message${verified.messageCount === 1 ? "" : "s"}\n`);
  return { ok: true };
}

async function runOAuthEmailSetup(io: SetupEmailIO, deps: Partial<SetupEmailDeps>): Promise<SetupEmailResult> {
  io.stdout(WALKTHROUGH);

  const clientIdInput = await (deps.promptClientId ?? defaultPromptClientId)();
  if (!clientIdInput) {
    io.stdout("Setup cancelled.\n");
    return { ok: false };
  }

  let clientId = clientIdInput;
  let clientSecret: string;
  const jsonKind = looksLikeClientSecretJsonInput(clientIdInput);
  if (jsonKind) {
    let content = clientIdInput;
    if (jsonKind === "path") {
      const expanded = clientIdInput.trim().replace(/^~(?=[\\/])/u, homedir());
      try {
        content = await (deps.readFileImpl ?? ((p: string) => readFile(p, "utf8")))(expanded);
      } catch {
        io.stderr(`muse setup email: could not read ${expanded}\n`);
        return { ok: false };
      }
    }
    const parsed = parseGoogleClientSecretJson(content);
    if (!parsed.ok) {
      io.stderr(`muse setup email: ${parsed.error}\n`);
      return { ok: false };
    }
    clientId = parsed.credentials.clientId;
    clientSecret = parsed.credentials.clientSecret;
    io.stdout("✓ Desktop-app client credentials read from the JSON\n");
  } else {
    const promptedSecret = await (deps.promptClientSecret ?? defaultPromptClientSecret)();
    if (!promptedSecret) {
      io.stdout("Setup cancelled.\n");
      return { ok: false };
    }
    clientSecret = promptedSecret;
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
