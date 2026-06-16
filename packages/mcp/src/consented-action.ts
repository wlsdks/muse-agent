/**
 * The act-as-the-user gate (P5-b3): a standing objective may only
 * perform an external action with the user's scoped service
 * credential when the user has RECORDED consent for that exact
 * {objective, scope}. Fail-closed and deterministic — no consent
 * record ⇒ no HTTP call, ever. Security is code here, not a prompt.
 *
 * Transport is injected (`fetchImpl`) so the action is exercised
 * over a real provider request shape with only the HTTP boundary
 * faked — never a fake "did the thing" flag.
 */

import { findConsent } from "./personal-consent-store.js";
import { hasVeto } from "./personal-veto-store.js";

export interface ConsentedActionRequest {
  readonly url: string;
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

export interface PerformConsentedActionOptions {
  readonly consentFile: string;
  readonly userId: string;
  readonly objectiveId: string;
  readonly scope: string;
  /** The user's scoped service token — only sent when consent holds. */
  readonly credential: string;
  readonly request: ConsentedActionRequest;
  readonly fetchImpl: typeof fetch;
  /**
   * Optional veto store. When set and a veto matches
   * {userId, objectiveId, scope}, the action is refused BEFORE the
   * consent check — a recorded veto overrides any prior consent
   * ("don't do this again" wins). Absent ⇒ consent-only gating.
   */
  readonly vetoFile?: string;
  /**
   * Hard wall-clock cap on the HTTP call once consent has passed.
   * Default 30_000ms. A consented endpoint that hangs (network
   * partition, misbehaving upstream, sock leak) must not be able to
   * stall the standing-objective loop indefinitely; on timeout the
   * outcome is `{ performed: false, reason: "consented action timed
   * out…" }` so the loop's next-tick cadence stays bounded.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_CONSENTED_ACTION_TIMEOUT_MS = 30_000;

export type ConsentedActionOutcome =
  | { readonly performed: false; readonly reason: string }
  | { readonly performed: true; readonly status: number };

export async function performConsentedAction(
  options: PerformConsentedActionOptions
): Promise<ConsentedActionOutcome> {
  if (options.vetoFile) {
    const vetoed = await hasVeto(options.vetoFile, {
      objectiveId: options.objectiveId,
      scope: options.scope,
      userId: options.userId
    });
    if (vetoed) {
      // A veto overrides prior consent — checked first, fail-closed.
      return { performed: false, reason: `vetoed: action class ${options.scope} for objective ${options.objectiveId}` };
    }
  }

  const consent = await findConsent(options.consentFile, {
    objectiveId: options.objectiveId,
    scope: options.scope,
    userId: options.userId
  });
  if (!consent) {
    // Fail-closed: no recorded consent ⇒ the credential is never
    // resolved, no request is ever made.
    return { performed: false, reason: `no recorded consent for scope ${options.scope}` };
  }

  // Bind the scoped credential to the destination the user consented to: when
  // the consent records an allowedHost, a caller-controlled request.url must not
  // be able to send the token to an arbitrary host (credential exfiltration).
  // Fail-closed on mismatch OR an unparseable URL — no HTTP, the token never leaves.
  if (consent.allowedHost !== undefined) {
    let requestHost: string;
    try {
      requestHost = new URL(options.request.url).host;
    } catch {
      return { performed: false, reason: `invalid request url: ${options.request.url}` };
    }
    if (requestHost !== consent.allowedHost) {
      return {
        performed: false,
        reason: `consent for scope ${options.scope} is bound to host ${consent.allowedHost}, not ${requestHost}`
      };
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CONSENTED_ACTION_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  // Strip any caller-supplied authorization header (case-insensitively) so the
  // consent-gated credential is the ONLY Bearer token that ever leaves — a
  // request.headers spread must never override or corrupt the code-owned token.
  const callerHeaders = Object.fromEntries(
    Object.entries(options.request.headers ?? {}).filter(([key]) => key.toLowerCase() !== "authorization")
  );
  try {
    response = await options.fetchImpl(options.request.url, {
      body: options.request.body,
      headers: {
        authorization: `Bearer ${options.credential}`,
        ...(options.request.body ? { "content-type": "application/json" } : {}),
        ...callerHeaders
      },
      method: options.request.method ?? "POST",
      // Do NOT auto-follow redirects: the host-binding above vets only the
      // ORIGINAL url, so a 3xx from the allowed host pointing elsewhere would
      // otherwise re-issue the request — Authorization: Bearer included — to an
      // un-consented host, exfiltrating the scoped credential (the same hole
      // web-action.ts closes). Handle the 3xx below, fail-closed.
      redirect: "manual",
      signal: controller.signal
    });
  } catch (cause) {
    const aborted = controller.signal.aborted;
    return aborted
      ? { performed: false, reason: `consented action timed out after ${timeoutMs.toString()}ms` }
      : { performed: false, reason: `consented action fetch failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  } finally {
    clearTimeout(timer);
  }
  // A redirect from the consented host would re-target the credential at an
  // unvetted host — refuse it (the credential is bound to the consented host,
  // never re-sent on a 3xx). Mirrors web-action.ts's redirect posture.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "(no location)";
    return {
      performed: false,
      reason: `refused to follow redirect to ${location} — the consented credential is bound to ${consent.allowedHost ?? options.request.url} and must not be re-sent to an unvetted host`
    };
  }
  return { performed: true, status: response.status };
}
