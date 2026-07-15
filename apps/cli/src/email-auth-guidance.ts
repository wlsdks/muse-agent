import { errorMessage } from "@muse/shared";
/**
 * AC3: turns a rejected-login error into a localized guidance line. The
 * package (`@muse/domain-tools`) stays locale-free — it only classifies
 * the rejection into a `code` (+ the redacted server line). This module
 * is the one place that maps `code` → the catalog entry the CLI shows,
 * shared by every catch site (`setup-email`'s verify step, `commands-email`,
 * `commands-inbox`, `commands-doctor-email`).
 */

import { ImapSmtpAuthError } from "@muse/domain-tools";

import { buildGmailAppPasswordUrls } from "./gmail-app-password-url.js";
import { t, type CliStringKey } from "./cli-i18n.js";

/**
 * `email` is the account the credential was minted for, when the caller
 * has it on hand (the setup wizard just prompted for it; `muse doctor`
 * reads it back off the stored credential) — it upgrades the
 * app-password-required guidance with an account-PINNED URL. Callers
 * that never learn the address (`muse inbox`, `muse email sync`, which
 * only hold an already-constructed provider) still get the guidance
 * sentence, just without the pinned link.
 */
export function formatEmailAuthGuidance(cause: unknown, email?: string): string {
  if (!(cause instanceof ImapSmtpAuthError) || cause.code === "auth-unknown") {
    return errorMessage(cause);
  }

  const guidanceKey: CliStringKey = cause.code === "app-password-required"
    ? "email.authError.appPasswordRequired"
    : cause.code === "invalid-credentials"
      ? "email.authError.invalidCredentials"
      : "email.authError.webLoginBlock";

  const lines = [t(guidanceKey)];
  if (cause.code === "app-password-required" && email) {
    lines.push(t("email.authError.appPasswordUrlHint", { url: buildGmailAppPasswordUrls(email).appPasswordUrl }));
  }
  if (cause.serverDetail) {
    lines.push(t("email.authError.serverDetail", { detail: cause.serverDetail }));
  }
  return lines.join(" ");
}

/**
 * The "Gmail isn't connected at all" hint (as opposed to `formatEmailAuthGuidance`'s
 * "connected but the login was rejected"). Shared by `muse inbox` and `muse email
 * sync` (E4b audit #10/#14) — was hand-duplicated with a `(gmail.readonly scope)`
 * suffix that's implementation jargon a user can't act on; dropped in favor of
 * naming the fix.
 */
export function noGmailAccessMessage(command: string): string {
  return t("email.notConfigured", { command });
}
