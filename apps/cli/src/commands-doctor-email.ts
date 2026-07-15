import { errorMessage } from "@muse/shared";
/**
 * `muse doctor`'s email auth check: is SOMETHING configured, and does a
 * live probe actually still work? Two configured shapes get a real probe:
 * the refreshing OAuth path (`muse setup email`'s choice 2) refreshes its
 * access token; the App Password path (choice 1, recommended) does a real
 * IMAP login + mailbox open. A raw MUSE_GMAIL_TOKEN has no refresh
 * mechanism to probe, so that branch only reports it's in use. Read-only:
 * never persists a refreshed token / invalid_grant marker / anything for
 * IMAP here — mutation belongs to the runtime token source
 * (gmail-oauth.ts), not to a diagnostic.
 */
import { ImapSmtpAuthError, ImapSmtpEmailProvider, type ImapSmtpEmailProviderConfig } from "@muse/domain-tools";

import { resolveCliLanguage } from "./cli-i18n.js";
import { readEmailImapCredential, readGmailCredential } from "./credential-store.js";
import { formatEmailAuthGuidance } from "./email-auth-guidance.js";
import { GmailOAuthInvalidGrantError, GmailOAuthRetryableError, refreshGmailAccessToken } from "./gmail-oauth.js";
import { readConfigStore } from "./program-config.js";
import type { ProgramIO } from "./program.js";

export interface EmailAuthCheckResult {
  readonly name: "email-auth";
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

// Email reads/sends your OWN data — it is not an LLM call, so MUSE_LOCAL_ONLY
// (which governs cloud-model egress) never blocks it. Surfaced here, on the
// "configured" branches, so the posture is visible without a second command.
const LOCAL_ONLY_NOTE = "not affected by MUSE_LOCAL_ONLY — email is your own data plane, not LLM egress";

export type VerifyImapConnection = (config: ImapSmtpEmailProviderConfig) => Promise<{ readonly messageCount: number }>;

async function defaultVerifyImapConnection(config: ImapSmtpEmailProviderConfig): Promise<{ readonly messageCount: number }> {
  return new ImapSmtpEmailProvider(config).verifyConnection();
}

export async function emailAuthCheck(
  io: ProgramIO,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  verifyImapConnection: VerifyImapConnection = defaultVerifyImapConnection
): Promise<EmailAuthCheckResult> {
  const name = "email-auth" as const;
  const envToken = env.MUSE_GMAIL_TOKEN?.trim();
  const credential = await readGmailCredential(io);
  const imapCredential = credential ? undefined : await readEmailImapCredential(io);

  if (!envToken && !credential && !imapCredential) {
    return { detail: "not connected (opt-in) — run `muse setup email` or set MUSE_GMAIL_TOKEN", name, status: "ok" };
  }
  if (imapCredential) {
    try {
      const { messageCount } = await verifyImapConnection(imapCredential);
      return { detail: `connected via app password (IMAP), login verified — inbox has ${messageCount.toString()} message${messageCount === 1 ? "" : "s"} — ${LOCAL_ONLY_NOTE}`, name, status: "ok" };
    } catch (cause) {
      if (cause instanceof ImapSmtpAuthError) {
        // AC3: localized, code-driven guidance (never the raw English
        // package message) — `imapCredential.email` is known here, so the
        // app-password-required case gets the account-pinned URL too.
        await resolveCliLanguage(env, () => readConfigStore(io));
        const guidance = formatEmailAuthGuidance(cause, imapCredential.email);
        return { detail: `connected but the IMAP login failed — ${guidance} Run \`muse setup email\` again.`, name, status: "fail" };
      }
      return { detail: `connected but couldn't verify the IMAP login right now: ${errorMessage(cause)}`, name, status: "warn" };
    }
  }
  if (!credential) {
    return { detail: `using MUSE_GMAIL_TOKEN (raw token, no refresh — expires hourly; \`muse setup email\` is the durable path) — ${LOCAL_ONLY_NOTE}`, name, status: "ok" };
  }
  if (credential.refreshTokenInvalid) {
    return { detail: "connected but the refresh token was revoked/expired — run `muse setup email` again", name, status: "fail" };
  }

  try {
    await refreshGmailAccessToken({
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      fetchImpl,
      refreshToken: credential.refreshToken
    });
    return { detail: `connected via OAuth, refresh verified — ${LOCAL_ONLY_NOTE}`, name, status: "ok" };
  } catch (cause) {
    if (cause instanceof GmailOAuthInvalidGrantError) {
      return { detail: "connected but the refresh token was revoked/expired — run `muse setup email` again", name, status: "fail" };
    }
    if (cause instanceof GmailOAuthRetryableError) {
      return { detail: "connected but couldn't verify the refresh right now (network) — try `muse doctor` again shortly", name, status: "warn" };
    }
    return { detail: `connected but the refresh check failed: ${errorMessage(cause)}`, name, status: "warn" };
  }
}

