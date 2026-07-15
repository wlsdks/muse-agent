/**
 * Single seam every email-provider construction site goes through
 * (daemon-watch-ticks, actuator-tools, commands-email, commands-inbox):
 * `MUSE_GMAIL_TOKEN` (explicit override — backcompat/tests/CI) wins when
 * set, else the encrypted OAuth record from `muse setup email`'s Google
 * OAuth path, else the encrypted App Password (IMAP/SMTP) record from its
 * recommended path. Stays fully synchronous — the OAuth refresh / IMAP
 * connect both happen lazily, per request, inside the provider — so every
 * existing sync call site (including `buildActuatorTools`) keeps its
 * signature.
 */

import type { MuseEnvironment } from "@muse/autoconfigure";
import { GmailEmailProvider, ImapSmtpEmailProvider, type EmailProvider, type EmailReader, type EmailSearcher, type EmailSender } from "@muse/domain-tools";
import type { RetryOptions } from "@muse/mcp-shared";

import { hasStoredGmailCredentialSync, readEmailImapCredentialSync } from "./credential-store.js";
import { createGmailTokenSource } from "./gmail-oauth.js";
import type { ProgramIO } from "./program.js";

export interface ResolveGmailProviderOptions {
  readonly io: ProgramIO;
  readonly env: MuseEnvironment;
  readonly fetchImpl?: typeof fetch;
  readonly retryOptions?: RetryOptions;
}

/** Either concrete provider implements the full read+send contract; every call site depends only on this shape, never on which transport backs it. */
export type ResolvedEmailProvider = EmailProvider & EmailSender & EmailReader & EmailSearcher;

/** Whether email_send/email_reply/`muse inbox`/`muse email` have SOMETHING to authenticate with (env override, a stored OAuth record, or a stored App Password record). */
export function isGmailConfigured(io: ProgramIO, env: MuseEnvironment): boolean {
  return Boolean(env.MUSE_GMAIL_TOKEN?.trim()) || hasStoredGmailCredentialSync(io) || readEmailImapCredentialSync(io) !== undefined;
}

/**
 * Synchronous resolution: env → OAuth → App Password. Unlike the OAuth
 * provider (which only needs a lazily-resolving token SOURCE at
 * construction time), `ImapSmtpEmailProvider` needs the full decrypted
 * `{email, appPassword, ...}` record up front — `readEmailImapCredentialSync`
 * gives it that without breaking this function's synchronous contract.
 * The IMAP connect/login itself still happens lazily on first use, exactly
 * like the OAuth provider's lazy token refresh.
 */
export function resolveGmailProvider(options: ResolveGmailProviderOptions): ResolvedEmailProvider | undefined {
  const envToken = options.env.MUSE_GMAIL_TOKEN?.trim();
  if (envToken) {
    return new GmailEmailProvider(envToken, options.fetchImpl, options.retryOptions ?? {});
  }
  if (hasStoredGmailCredentialSync(options.io)) {
    const getAccessToken = createGmailTokenSource({ env: options.env, fetchImpl: options.fetchImpl, io: options.io });
    return new GmailEmailProvider(getAccessToken, options.fetchImpl, options.retryOptions ?? {});
  }
  const imapCredential = readEmailImapCredentialSync(options.io);
  return imapCredential ? new ImapSmtpEmailProvider(imapCredential) : undefined;
}
