import { fetchWithTimeout, tryParseJson } from "./provider-helpers.js";

export type TokenVerification =
  | { readonly ok: true; readonly account?: string }
  | { readonly ok: false; readonly reason: string };

export interface VerifyTokenOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Live credential check against the provider's own identity endpoint —
 * the gate a token must pass BEFORE it is persisted, so a typo'd or
 * revoked token is rejected at connect time instead of failing on the
 * first real send. Fail-close: any error (HTTP, network, unknown
 * provider) verifies as NOT ok; this function never throws.
 */
export async function verifyMessagingToken(
  providerId: string,
  token: string,
  options: VerifyTokenOptions = {}
): Promise<TokenVerification> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  try {
    switch (providerId) {
      case "telegram": {
        const response = await fetchWithTimeout(
          fetchImpl,
          `https://api.telegram.org/bot${token}/getMe`,
          { method: "GET" },
          timeoutMs
        );
        const body = tryParseJson<{ ok?: boolean; description?: string; result?: { username?: string } }>(
          await response.text()
        );
        if (!response.ok || body?.ok !== true) {
          return { ok: false, reason: body?.description ?? `Telegram getMe failed (HTTP ${response.status.toString()})` };
        }
        const username = body.result?.username;
        return { ok: true, ...(username ? { account: `@${username}` } : {}) };
      }
      case "discord": {
        const response = await fetchWithTimeout(
          fetchImpl,
          "https://discord.com/api/v10/users/@me",
          { headers: { authorization: `Bot ${token}` }, method: "GET" },
          timeoutMs
        );
        const body = tryParseJson<{ username?: string; message?: string }>(await response.text());
        if (!response.ok) {
          return { ok: false, reason: body?.message ?? `Discord users/@me failed (HTTP ${response.status.toString()})` };
        }
        return { ok: true, ...(body?.username ? { account: body.username } : {}) };
      }
      case "slack": {
        const response = await fetchWithTimeout(
          fetchImpl,
          "https://slack.com/api/auth.test",
          { headers: { authorization: `Bearer ${token}` }, method: "POST" },
          timeoutMs
        );
        const body = tryParseJson<{ ok?: boolean; error?: string; user?: string }>(await response.text());
        if (!response.ok || body?.ok !== true) {
          return { ok: false, reason: body?.error ?? `Slack auth.test failed (HTTP ${response.status.toString()})` };
        }
        return { ok: true, ...(body.user ? { account: body.user } : {}) };
      }
      case "line": {
        const response = await fetchWithTimeout(
          fetchImpl,
          "https://api.line.me/v2/bot/info",
          { headers: { authorization: `Bearer ${token}` }, method: "GET" },
          timeoutMs
        );
        const body = tryParseJson<{ basicId?: string; displayName?: string; message?: string }>(await response.text());
        if (!response.ok) {
          return { ok: false, reason: body?.message ?? `LINE bot/info failed (HTTP ${response.status.toString()})` };
        }
        const account = body?.basicId ?? body?.displayName;
        return { ok: true, ...(account ? { account } : {}) };
      }
      default:
        return { ok: false, reason: `unknown messaging provider "${providerId}"` };
    }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
