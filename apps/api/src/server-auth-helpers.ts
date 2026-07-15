import type { AuthIdentity, LoginResult } from "@muse/auth";

/**
 * Auth-identity helpers extracted from `server-helpers.ts`.
 *
 * The four functions all deal with the per-request auth identity
 * (attach / read / shape) and the per-route auth guard
 * (`requireAuthenticated`). Lifted into a dedicated module so the
 * cluster's intent — "everything about request-bound auth" — is
 * one file rather than the tail of a 1,000-LOC helpers grab-bag.
 *
 * Re-exported from `server-helpers.ts` so the existing 10 import
 * sites across the API package keep working without import-site
 * edits.
 */

export function attachAuthIdentity(request: unknown, identity: AuthIdentity | undefined): void {
  (request as { auth?: AuthIdentity }).auth = identity;
}

export function getAuthIdentity(request: unknown): AuthIdentity | undefined {
  return (request as { auth?: AuthIdentity }).auth;
}

export function toLoginResponse(login: LoginResult) {
  return {
    expiresAt: login.expiresAt.toISOString(),
    token: login.token,
    user: login.user
  };
}

/**
 * Per-route auth guard. Returns true to continue, or writes a 401 reply
 * and returns false. When `authEnabled` is false (the personal-use
 * default), every request passes — there's no separate role tier in
 * this 1-user codebase. Only the presence of an identity is checked
 * when auth is enabled.
 *
 * Was previously named `authorizeAdmin`; the "Admin" suffix was Reactor
 * multi-tenant residue (no admin role exists here).
 */
export function requireAuthenticated(
  request: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  authEnabled: boolean
): boolean {
  if (!authEnabled) {
    return true;
  }

  if (getAuthIdentity(request)) {
    return true;
  }

  reply.status(401).send({
    error: "인증이 필요합니다",
    timestamp: new Date().toISOString()
  });
  return false;
}
