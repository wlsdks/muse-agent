/**
 * `muse doctor`'s Gmail auth check: is SOMETHING configured, and — for the
 * refreshing OAuth path (`muse setup email`) — does a live refresh actually
 * still work? A raw MUSE_GMAIL_TOKEN has no refresh mechanism to probe, so
 * that branch only reports it's in use. Read-only: never persists a
 * refreshed token or an invalid_grant marker here — that mutation belongs
 * to the runtime token source (gmail-oauth.ts), not to a diagnostic.
 */
import { readGmailCredential } from "./credential-store.js";
import { GmailOAuthInvalidGrantError, GmailOAuthRetryableError, refreshGmailAccessToken } from "./gmail-oauth.js";
import type { ProgramIO } from "./program.js";

export interface EmailAuthCheckResult {
  readonly name: "email-auth";
  readonly status: "ok" | "warn" | "fail";
  readonly detail: string;
}

// Gmail reads/sends your OWN data — it is not an LLM call, so MUSE_LOCAL_ONLY
// (which governs cloud-model egress) never blocks it. Surfaced here, on the
// "configured" branches, so the posture is visible without a second command.
const LOCAL_ONLY_NOTE = "not affected by MUSE_LOCAL_ONLY — Gmail is your own data plane, not LLM egress";

export async function emailAuthCheck(
  io: ProgramIO,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch
): Promise<EmailAuthCheckResult> {
  const name = "email-auth" as const;
  const envToken = env.MUSE_GMAIL_TOKEN?.trim();
  const credential = await readGmailCredential(io);

  if (!envToken && !credential) {
    return { detail: "not connected (opt-in) — run `muse setup email` or set MUSE_GMAIL_TOKEN", name, status: "ok" };
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
    return { detail: `connected but the refresh check failed: ${cause instanceof Error ? cause.message : String(cause)}`, name, status: "warn" };
  }
}
