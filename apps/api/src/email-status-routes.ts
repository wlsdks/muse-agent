/**
 * `GET /api/email/status` — the web console's Integrations tab answer to
 * "is my email connected?", mirroring `registerProactiveRoutes`'s shape.
 *
 * Reads the SAME encrypted `~/.config/muse/credentials.json` the CLI's
 * `muse setup email` writes (`@muse/stores`'s `readGmailCredential` /
 * `readEmailImapCredential`, moved there in R2-2 specifically so this
 * route could exist without apps/api importing from apps/cli). Never
 * echoes a token/secret/client id/app password — only a boolean + method
 * label. A decryption failure or absent file degrades to
 * `configured: false` (both readers are fail-soft), never a 500.
 *
 * `method` mirrors `resolveGmailProvider`'s (apps/cli/src/resolve-gmail-
 * provider.ts) REAL precedence, not just "does an oauth record exist": a
 * marked-invalid OAuth record (`refreshTokenInvalid`, set when a refresh hit
 * `invalid_grant` — see gmail-oauth.ts) is unusable, so the resolver falls
 * through to the App Password record when one is stored, exactly like
 * `hasStoredGmailCredentialSync` already does for `muse setup`'s status row.
 * Reporting `method:"oauth"` here regardless would be a display lie — the
 * resolver isn't actually using it. `needsReauth:true` surfaces whenever the
 * stored OAuth record is invalid, whether or not IMAP is there to fall back
 * to, so the UI can prompt reauth even on the imap-fallback path.
 */

import { readEmailImapCredential, readGmailCredential, type CredentialStoreIO } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export interface EmailStatusGate {
  readonly authService?: ServerOptions["authService"];
  /**
   * Directory holding `credentials.json` — same semantics as the CLI's
   * `ProgramIO.configDir`. Absent ⇒ the default `~/.config/muse/` path
   * (the SAME store `muse setup email` writes to on this machine).
   * Test-injectable so a fixture credentials file can be pointed at
   * without touching the real user directory.
   */
  readonly credentialsDir?: string;
  /** Injectable for tests; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface EmailStatusResponse {
  readonly configured: boolean;
  readonly method: "oauth" | "imap" | "env" | null;
  readonly hasRefreshToken?: boolean;
  /** `true` when a stored OAuth record exists but is marked invalid (revoked/expired refresh token) — reauth via `muse setup email` clears it. */
  readonly needsReauth?: boolean;
}

export function registerEmailStatusRoutes(server: FastifyInstance, gate: EmailStatusGate): void {
  server.get("/api/email/status", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const env = gate.env ?? process.env;
    if (env.MUSE_GMAIL_TOKEN?.trim()) {
      const response: EmailStatusResponse = { configured: true, method: "env" };
      return response;
    }
    // credentialKey mirrors what `deriveCredentialKey` would otherwise read
    // straight off real `process.env.MUSE_CREDENTIAL_KEY` — threading it
    // through the resolved `env` (rather than leaving it implicit) keeps
    // the test-injected `env` authoritative for encryption too, not just
    // the MUSE_GMAIL_TOKEN check above.
    const io: CredentialStoreIO = { configDir: gate.credentialsDir, credentialKey: env.MUSE_CREDENTIAL_KEY };
    const credential = await readGmailCredential(io);
    const oauthUsable = credential !== undefined && !credential.refreshTokenInvalid;
    if (oauthUsable) {
      const response: EmailStatusResponse = {
        configured: true,
        hasRefreshToken: Boolean(credential.refreshToken),
        method: "oauth"
      };
      return response;
    }
    // Oauth is either absent or marked invalid — mirror the resolver's real
    // fall-through to the App Password record before reporting anything.
    const imapCredential = await readEmailImapCredential(io);
    const needsReauth = credential?.refreshTokenInvalid === true;
    if (imapCredential) {
      const response: EmailStatusResponse = {
        configured: true,
        method: "imap",
        ...(needsReauth ? { needsReauth: true } : {})
      };
      return response;
    }
    const response: EmailStatusResponse = {
      configured: false,
      method: null,
      ...(needsReauth ? { needsReauth: true } : {})
    };
    return response;
  });
}
