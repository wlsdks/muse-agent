/**
 * Single seam every Gmail-provider construction site goes through
 * (daemon-watch-ticks, actuator-tools, commands-email, commands-inbox):
 * `MUSE_GMAIL_TOKEN` (explicit override — backcompat/tests/CI) wins when
 * set, else the encrypted OAuth record from `muse setup email` is wired in
 * as a lazily-resolving token source. Stays fully synchronous — the OAuth
 * refresh itself happens lazily, per request, inside the provider — so
 * every existing sync call site (including `buildActuatorTools`) keeps its
 * signature.
 */

import type { MuseEnvironment } from "@muse/autoconfigure";
import { GmailEmailProvider } from "@muse/domain-tools";
import type { RetryOptions } from "@muse/mcp-shared";

import { hasStoredGmailCredentialSync } from "./credential-store.js";
import { createGmailTokenSource } from "./gmail-oauth.js";
import type { ProgramIO } from "./program.js";

export interface ResolveGmailProviderOptions {
  readonly io: ProgramIO;
  readonly env: MuseEnvironment;
  readonly fetchImpl?: typeof fetch;
  readonly retryOptions?: RetryOptions;
}

/** Whether email_send/email_reply/`muse inbox`/`muse email` have SOMETHING to authenticate with (env override or a stored OAuth record). */
export function isGmailConfigured(io: ProgramIO, env: MuseEnvironment): boolean {
  return Boolean(env.MUSE_GMAIL_TOKEN?.trim()) || hasStoredGmailCredentialSync(io);
}

export function resolveGmailProvider(options: ResolveGmailProviderOptions): GmailEmailProvider | undefined {
  const envToken = options.env.MUSE_GMAIL_TOKEN?.trim();
  if (envToken) {
    return new GmailEmailProvider(envToken, options.fetchImpl, options.retryOptions ?? {});
  }
  if (!hasStoredGmailCredentialSync(options.io)) {
    return undefined;
  }
  const getAccessToken = createGmailTokenSource({ env: options.env, fetchImpl: options.fetchImpl, io: options.io });
  return new GmailEmailProvider(getAccessToken, options.fetchImpl, options.retryOptions ?? {});
}
