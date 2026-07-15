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

import { confirm, password, select, text, isCancel } from "@clack/prompts";
import { ImapSmtpEmailProvider, type ImapSmtpEmailProviderConfig } from "@muse/domain-tools";
import { startOAuthCallbackServer, type OAuthCallbackServer } from "@muse/mcp";

import { isNoInput } from "./cli-context.js";
import { resolveCliLanguage, t } from "./cli-i18n.js";
import { writeEmailImapCredential, writeGmailCredential, type GmailOAuthCredential, type ImapEmailCredential } from "./credential-store.js";
import { formatEmailAuthGuidance } from "./email-auth-guidance.js";
import { buildGmailAppPasswordUrls } from "./gmail-app-password-url.js";
import { readConfigStore } from "./program-config.js";
import { generateOAuthState, generatePkcePair } from "./setup-calendar.js";
import { exchangeGmailAuthorizationCode, GMAIL_AUTH_ENDPOINT, GMAIL_SCOPES, googlePreflightGuidance, looksLikeClientSecretJsonInput, parseGoogleClientSecretJson, preflightGoogleOAuthClient, validateGoogleOAuthClientIdInput, type GmailClientPreflightResult, type GmailTokenExchangeResult } from "./gmail-oauth.js";
import type { ProgramIO } from "./program.js";

export { buildGmailAppPasswordUrls } from "./gmail-app-password-url.js";

const PREFLIGHT_GUIDANCE = googlePreflightGuidance("muse setup email");

/** Every entrypoint below is independently testable/callable, so each resolves language for itself; `resolveCliLanguage` caches per process, so calling it from several entry points costs nothing after the first. */
async function ensureLanguageResolved(io: SetupEmailIO): Promise<void> {
  await resolveCliLanguage(io.env ?? process.env, () => readConfigStore(io));
}

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

    params.stdout(`${t("email.oauth.authUrl", { redirectUri, url: authUrl.toString() })}\n`);
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
    message: t("email.oauth.prompt.clientId"),
    placeholder: "xxx.apps.googleusercontent.com  ·  ~/Downloads/client_secret_xxx.json",
    validate: (input) => looksLikeClientSecretJsonInput(input ?? "") ? undefined : validateGoogleOAuthClientIdInput(input)
  });
  return isCancel(value) || typeof value !== "string" || value.trim().length === 0 ? undefined : value.trim();
}

async function defaultPromptClientSecret(): Promise<string | undefined> {
  const value = await password({ message: t("email.oauth.prompt.clientSecret") });
  return isCancel(value) || typeof value !== "string" || value.length === 0 ? undefined : value;
}

/** macOS `open` best-effort; every other platform falls back to the printed URL (runGmailOAuthLoopback always prints it). */
/**
 * Opening a REAL browser from a test is a user-visible incident, not a
 * harmless side effect: an un-injected wizard test popped Google login
 * tabs on the owner's desktop every time the suite ran. Same hard
 * boundary as the launchctl/tailscale exec seams — under vitest this is
 * a no-op even when a test forgets to inject openBrowser.
 */
export function defaultOpenBrowser(url: string, spawnImpl: typeof spawn = spawn): void {
  const underVitest = (process.env.VITEST ?? "").trim().length > 0 || process.env.VITEST_WORKER_ID !== undefined;
  if (underVitest) return;
  if (process.platform !== "darwin") return;
  try {
    spawnImpl("open", [url], { stdio: "ignore" }).on("error", () => undefined);
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
  /** macOS `open`, shared with the OAuth path's `defaultOpenBrowser`. */
  readonly openBrowser?: (url: string) => Promise<void> | void;
  /** Gmail-only: offer to open the account-pinned app-password page. Defaults to a clack confirm, skipped (never offered) under `--no-input` or a non-TTY session. */
  readonly confirmOpenBrowser?: (message: string) => Promise<boolean>;
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
    message: t("email.method.prompt"),
    options: [
      { hint: t("email.method.appPassword.hint"), label: t("email.method.appPassword.label"), value: "apppassword" as const },
      { hint: t("email.method.oauth.hint"), label: t("email.method.oauth.label"), value: "oauth" as const }
    ]
  });
  return isCancel(value) ? undefined : value;
}

export async function runEmailSetup(io: SetupEmailIO, deps: Partial<SetupEmailDeps> = {}): Promise<SetupEmailResult> {
  await ensureLanguageResolved(io);
  const method = await (deps.promptMethod ?? defaultPromptMethod)();
  if (!method) {
    io.stdout(`${t("email.setupCancelled")}\n`);
    return { ok: false };
  }
  if (method === "apppassword") {
    return runAppPasswordEmailSetup(io, deps);
  }
  return runOAuthEmailSetup(io, deps);
}

/** The address family that gets Gmail's IMAP/SMTP hosts by default and the account-pinned app-password-page offer. */
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Korean webmail providers get a short NAMED note (IMAP + app-password
 * location) instead of Google's wall. Only `naver.com` ships prefillable
 * host defaults — verified against Naver's own DNS (`imap.naver.com` /
 * `smtp.naver.com` resolve to Naver-operated mail infrastructure); the
 * other three have no publicly confirmable default here, so they fall
 * through to a blank host prompt like any unlisted provider.
 */
const KO_WEBMAIL_PROVIDERS: Readonly<Record<string, { readonly label: string; readonly imapHost?: string; readonly smtpHost?: string }>> = {
  "daum.net": { label: "다음 메일 (Daum Mail)" },
  "hanmail.net": { label: "한메일 (Hanmail)" },
  "kakao.com": { label: "카카오메일 (Kakao Mail)" },
  "naver.com": { imapHost: "imap.naver.com", label: "네이버 메일 (Naver Mail)", smtpHost: "smtp.naver.com" }
};

export type EmailProviderClass =
  | { readonly kind: "gmail" }
  | { readonly kind: "ko-webmail"; readonly label: string; readonly imapHost?: string; readonly smtpHost?: string }
  | { readonly kind: "generic" };

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/** Pure domain router behind the App Password flow's branching (AC1) — no prompt/IO here, so it's directly unit-testable. */
export function classifyEmailProvider(email: string): EmailProviderClass {
  const domain = emailDomain(email);
  if (GMAIL_DOMAINS.has(domain)) return { kind: "gmail" };
  const koProvider = KO_WEBMAIL_PROVIDERS[domain];
  if (koProvider) return { kind: "ko-webmail", ...koProvider };
  return { kind: "generic" };
}

function koWebmailNote(label: string): string {
  return `${t("email.koWebmail.note", { label })}\n\n`;
}

/** Skipped (never offered — no clack prompt) under `--no-input` or a non-TTY session, so a scripted run never hangs. */
async function defaultConfirmOpenBrowser(message: string): Promise<boolean> {
  if (isNoInput() || !process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = await confirm({ initialValue: true, message });
  return isCancel(answer) ? false : answer === true;
}

async function presentGmailAppPasswordStep(io: SetupEmailIO, email: string, deps: Partial<AppPasswordSetupDeps>): Promise<void> {
  const { appPasswordUrl, twoStepUrl } = buildGmailAppPasswordUrls(email);
  io.stdout(`${t("email.gmail.appPasswordStep", { appPasswordUrl, email, twoStepUrl })}\n`);
  const confirmOpen = deps.confirmOpenBrowser ?? defaultConfirmOpenBrowser;
  const shouldOpen = await confirmOpen(t("email.gmail.openBrowserConfirm"));
  if (!shouldOpen) return;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  try {
    await openBrowser(appPasswordUrl);
  } catch {
    // Non-blocking open step — the printed URL above is the real fallback.
  }
}

async function defaultPromptEmail(): Promise<string | undefined> {
  const value = await text({
    message: t("email.prompt.email"),
    placeholder: "you@gmail.com",
    validate: (input) => {
      const trimmed = (input ?? "").trim();
      if (trimmed.length === 0) return t("email.prompt.email.required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)) return t("email.prompt.email.invalidFormat");
      return undefined;
    }
  });
  return isCancel(value) || typeof value !== "string" || value.trim().length === 0 ? undefined : value.trim();
}

async function defaultPromptAppPassword(): Promise<string | undefined> {
  const value = await password({
    message: t("email.prompt.appPassword"),
    validate: (input) => ((input ?? "").replace(/\s+/gu, "").length === 0 ? t("email.prompt.appPassword.required") : undefined)
  });
  if (isCancel(value) || typeof value !== "string") return undefined;
  const stripped = value.replace(/\s+/gu, "");
  return stripped.length > 0 ? stripped : undefined;
}

async function defaultPromptHost(label: string, prefill?: string): Promise<string | undefined> {
  const value = await text({
    initialValue: prefill,
    message: t("email.prompt.host", { label }),
    placeholder: `${label.toLowerCase()}.example.com`
  });
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
  await ensureLanguageResolved(io);
  const email = await (deps.promptEmail ?? defaultPromptEmail)();
  if (!email) {
    io.stdout(`${t("email.setupCancelled")}\n`);
    return { ok: false };
  }

  let imapHost: string | undefined;
  let smtpHost: string | undefined;
  const provider = classifyEmailProvider(email);
  if (provider.kind === "gmail") {
    await presentGmailAppPasswordStep(io, email, deps);
  } else if (provider.kind === "ko-webmail") {
    io.stdout(koWebmailNote(provider.label));
    imapHost = await (deps.promptImapHost ?? (() => defaultPromptHost("IMAP", provider.imapHost)))();
    smtpHost = await (deps.promptSmtpHost ?? (() => defaultPromptHost("SMTP", provider.smtpHost)))();
  } else {
    imapHost = await (deps.promptImapHost ?? (() => defaultPromptHost("IMAP")))();
    smtpHost = await (deps.promptSmtpHost ?? (() => defaultPromptHost("SMTP")))();
  }

  const rawAppPassword = await (deps.promptAppPassword ?? defaultPromptAppPassword)();
  // Spaces stripped unconditionally here (not just in the default prompt) —
  // Google always displays the 16 characters with spaces, and a pasted
  // value must be normalised the same way whether the prompt is real or
  // injected by a test.
  const appPassword = rawAppPassword?.replace(/\s+/gu, "");
  if (!appPassword) {
    io.stdout(`${t("email.setupCancelled")}\n`);
    return { ok: false };
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
    io.stderr(`${t("email.appPassword.verifyFailed", { detail: formatEmailAuthGuidance(verified.error, email) })}\n`);
    return { ok: false };
  }

  await writeEmailImapCredential(io, credential);
  io.stdout(`${t("email.appPassword.connected", { count: verified.messageCount })}\n`);
  return { ok: true };
}

async function runOAuthEmailSetup(io: SetupEmailIO, deps: Partial<SetupEmailDeps>): Promise<SetupEmailResult> {
  await ensureLanguageResolved(io);
  io.stdout(`${t("email.oauth.walkthrough")}\n`);

  const clientIdInput = await (deps.promptClientId ?? defaultPromptClientId)();
  if (!clientIdInput) {
    io.stdout(`${t("email.setupCancelled")}\n`);
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
        io.stderr(`${t("email.oauth.jsonRead.fail", { path: expanded })}\n`);
        return { ok: false };
      }
    }
    const parsed = parseGoogleClientSecretJson(content);
    if (!parsed.ok) {
      io.stderr(`${t("email.oauth.jsonParse.fail", { reason: parsed.error })}\n`);
      return { ok: false };
    }
    clientId = parsed.credentials.clientId;
    clientSecret = parsed.credentials.clientSecret;
    io.stdout(`${t("email.oauth.jsonRead.ok")}\n`);
  } else {
    const promptedSecret = await (deps.promptClientSecret ?? defaultPromptClientSecret)();
    if (!promptedSecret) {
      io.stdout(`${t("email.setupCancelled")}\n`);
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
    io.stderr(`${t("email.oauth.authFailed", { reason: result.reason })}\n`);
    return { ok: false };
  }

  await writeGmailCredential(io, result.credential);
  io.stdout(`${t("email.oauth.connected")}\n`);

  const verifyProfile = deps.verifyProfile ?? defaultVerifyGmailProfile;
  const emailAddress = result.credential.accessToken ? await verifyProfile(result.credential.accessToken, fetchImpl) : undefined;
  if (emailAddress) {
    io.stdout(`${t("email.oauth.connectedAs", { email: emailAddress })}\n`);
  } else {
    io.stderr(`${t("email.oauth.verifySoftFail")}\n`);
  }

  return { ok: true };
}
