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

import { errorMessage, redactSecretsInText } from "@muse/shared";

import { findConsent } from "@muse/stores";
import { appendActionLog, type ActionResult } from "@muse/stores";
import { hasVeto } from "@muse/stores";

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
  /**
   * Optional reviewable action-log file. When set, EVERY outcome — performed OR
   * refused on any branch (veto / no-consent / host-mismatch / redirect /
   * timeout / transport error) — appends one rationale-bearing entry
   * (outbound-safety rule 4: "every outbound action, sent OR refused, records a
   * reviewable entry"). Absent ⇒ no log written (opt-in, back-compat). The
   * scoped credential is NEVER written to the log; the request body is
   * secret-scrubbed and length-capped like every other send path.
   */
  readonly actionLogFile?: string;
  /** Injected clock for the log entry timestamp (test determinism). */
  readonly now?: () => Date;
  /** Injected id factory for the log entry id (test determinism). */
  readonly idFactory?: () => string;
}

const DEFAULT_CONSENTED_ACTION_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type ConsentedActionOutcome =
  | { readonly performed: false; readonly reason: string }
  | { readonly performed: true; readonly status: number };

function resolveConsentedActionTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_CONSENTED_ACTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    return DEFAULT_CONSENTED_ACTION_TIMEOUT_MS;
  }
  return timeoutMs;
}

export async function performConsentedAction(
  options: PerformConsentedActionOptions
): Promise<ConsentedActionOutcome> {
  const now = options.now ?? (() => new Date());
  const at = now();
  const idFactory = options.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
  // The request body IS the content of the state-changing action; record it
  // secret-scrubbed + length-capped (the log is long-lived and may sync). The
  // scoped Bearer credential is code-owned and never part of what/detail.
  const bodyNote = typeof options.request.body === "string" && options.request.body.length > 0
    ? ` body: ${redactSecretsInText(options.request.body).slice(0, 500)}`
    : "";
  const log = async (result: ActionResult, detail: string): Promise<void> => {
    if (options.actionLogFile === undefined) return;
    await appendActionLog(options.actionLogFile, {
      detail,
      id: idFactory(),
      objectiveId: options.objectiveId,
      result,
      userId: options.userId,
      what: `consented action: ${options.request.method ?? "POST"} ${options.request.url} (scope ${options.scope})${bodyNote}`,
      when: at.toISOString(),
      why: `standing-objective ${options.objectiveId}: consented action for scope ${options.scope}`
    });
  };

  if (options.vetoFile) {
    const vetoed = await hasVeto(options.vetoFile, {
      objectiveId: options.objectiveId,
      scope: options.scope,
      userId: options.userId
    });
    if (vetoed) {
      // A veto overrides prior consent — checked first, fail-closed.
      const reason = `vetoed: action class ${options.scope} for objective ${options.objectiveId}`;
      await log("refused", reason);
      return { performed: false, reason };
    }
  }

  const consent = await findConsent(
    options.consentFile,
    { objectiveId: options.objectiveId, scope: options.scope, userId: options.userId },
    at
  );
  if (!consent) {
    // Fail-closed: no recorded consent for the exact scope, OR the only
    // matching record is past its expiresAt (findConsent treats an expired
    // consent as absent) ⇒ the credential is never resolved, no request is
    // ever made. One generic reason for both: distinguishing "expired" from
    // "never granted" here would mean re-reading consents unfiltered and
    // duplicating findConsent's expiry check in a second place.
    const reason = `no recorded consent for scope ${options.scope}`;
    await log("refused", reason);
    return { performed: false, reason };
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
      const reason = `invalid request url: ${options.request.url}`;
      await log("refused", reason);
      return { performed: false, reason };
    }
    if (requestHost !== consent.allowedHost) {
      const reason = `consent for scope ${options.scope} is bound to host ${consent.allowedHost}, not ${requestHost}`;
      await log("refused", reason);
      return { performed: false, reason };
    }
  }

  const timeoutMs = resolveConsentedActionTimeoutMs(options.timeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
      ...(timeoutSignal ? { signal: timeoutSignal } : {})
    });
  } catch (cause) {
    const timedOut = timeoutSignal.aborted;
    const reason = timedOut
      ? `consented action timed out after ${timeoutMs.toString()}ms`
      : `consented action fetch failed: ${errorMessage(cause)}`;
    await log("failed", reason);
    return { performed: false, reason };
  }
  // A redirect from the consented host would re-target the credential at an
  // unvetted host — refuse it (the credential is bound to the consented host,
  // never re-sent on a 3xx). Mirrors web-action.ts's redirect posture.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "(no location)";
    const reason = `refused to follow redirect to ${location} — the consented credential is bound to ${consent.allowedHost ?? options.request.url} and must not be re-sent to an unvetted host`;
    await log("refused", reason);
    return { performed: false, reason };
  }
  await log("performed", `HTTP ${response.status.toString()}`);
  return { performed: true, status: response.status };
}
