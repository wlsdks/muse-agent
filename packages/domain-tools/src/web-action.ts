/**
 * Draft-first, fail-closed agentic web action — submitting a
 * form, booking, or any state-changing HTTP request to a third party.
 * Governed by `.claude/rules/outbound-safety.md`: the action is
 * approval-gated and NEVER autonomous; absent an explicit confirm the
 * request is blocked and no HTTP is ever made; every outcome (performed
 * / refused / failed) is action-logged.
 *
 * The same fail-closed shape as `sendEmailWithApproval` /
 * `performConsentedAction`: security is deterministic code, the
 * transport is injected so the gate is exercised over a real request
 * shape with only the HTTP boundary faked — never a "did it" flag.
 *
 * Out of scope per `outbound-safety.md`: banking / payments / money
 * movement. This primitive must not be used for those.
 */

import { redactSecretsInText } from "@muse/shared";

import { appendActionLog } from "@muse/stores";
import { parseRetryAfterMs } from "@muse/mcp-shared";

export interface WebActionRequest {
  readonly url: string;
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

export interface WebActionApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/** Presents the EXACT action (summary + request) to the user. */
export type WebActionApprovalGate = (
  action: { readonly summary: string; readonly request: WebActionRequest }
) => Promise<WebActionApprovalDecision> | WebActionApprovalDecision;

export interface PerformWebActionWithApprovalOptions {
  /** Human-readable description of the action ("Book a table at X, 7pm"). */
  readonly summary: string;
  readonly request: WebActionRequest;
  readonly approvalGate: WebActionApprovalGate;
  readonly fetchImpl: typeof fetch;
  readonly actionLogFile: string;
  readonly userId: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Hard wall-clock cap once approved. Default 30_000ms. */
  readonly timeoutMs?: number;
  /**
   * Retry ONLY a 429 rate-limit (honouring Retry-After), for an IDEMPOTENT
   * actuator (e.g. Home Assistant `call_service` — setting a state). A 429 is
   * rejected BEFORE the action applies, so a retry can't double-act. Default
   * off — a generic web submit (form/booking) is non-idempotent and stays
   * single-shot. A 5xx / network reject is AMBIGUOUS and is NEVER retried
   * either way (it may have applied).
   */
  readonly retryOn429?: boolean;
  /** 429 retry budget (extra attempts). Default 2. */
  readonly retries?: number;
  /** First backoff in ms when no Retry-After; doubles per attempt. Default 250. */
  readonly baseDelayMs?: number;
  /** Cap on a server-supplied Retry-After. Default 30_000. */
  readonly maxRetryAfterMs?: number;
  /** Injectable delay so tests don't wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WEB_ACTION_TIMEOUT_MS = 30_000;

export type WebActionOutcome =
  | { readonly performed: true; readonly status: number }
  | { readonly performed: false; readonly reason: "denied" | "failed" | "timed-out"; readonly detail: string };

export async function performWebActionWithApproval(
  options: PerformWebActionWithApprovalOptions
): Promise<WebActionOutcome> {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
  // The request body IS the exact content of a state-changing web
  // action (the form / JSON being submitted), so the reviewable action
  // log must record it (outbound-safety rule 4). Secret-scrubbed (the
  // log is long-lived and may sync) and length-capped to bound size.
  const body = options.request.body;
  const bodyNote = typeof body === "string" && body.length > 0
    ? ` body: ${redactSecretsInText(body).slice(0, 500)}`
    : "";
  const log = (result: "performed" | "refused" | "failed", detail: string): Promise<void> =>
    appendActionLog(options.actionLogFile, {
      detail,
      id: idFactory(),
      result,
      userId: options.userId,
      what: `web action: ${options.summary} (${options.request.method ?? "POST"} ${options.request.url})${bodyNote}`,
      when: now().toISOString(),
      why: result === "refused" ? "web action refused (not confirmed)" : "user-approved web action"
    });

  // Draft-first + fail-closed gate: deny OR a thrown gate ⇒ no HTTP.
  let decision: WebActionApprovalDecision;
  try {
    decision = await options.approvalGate({ request: options.request, summary: options.summary });
  } catch (cause) {
    decision = { approved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!decision.approved) {
    await log("refused", decision.reason ?? "not approved");
    return { detail: decision.reason ?? "not approved", performed: false, reason: "denied" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_WEB_ACTION_TIMEOUT_MS;
  // Approval ran ONCE above; the loop only re-transmits (never re-approves).
  const retries = options.retryOn429 === true ? Math.max(0, Math.trunc(options.retries ?? 2)) : 0;
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? 30_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await options.fetchImpl(options.request.url, {
        method: options.request.method ?? "POST",
        // A state-changing action must NOT silently follow a 3xx: the SSRF guard
        // (assertPublicHttpUrl) vetted ONLY the original URL, so an auto-followed
        // redirect could re-issue the request — body included on 307/308 — to a
        // private/loopback host (169.254.169.254, 127.0.0.1) it never saw. The
        // read path (fetchReadableUrl) already re-checks the final host; this
        // write path fails closed instead of following.
        redirect: "manual",
        signal: controller.signal,
        ...(options.request.body !== undefined ? { body: options.request.body } : {}),
        headers: {
          ...(options.request.body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.request.headers
        }
      });
    } catch (cause) {
      // A timeout / network reject is AMBIGUOUS (the action may have applied) —
      // never retried, even for an idempotent actuator.
      const aborted = controller.signal.aborted;
      const detail = aborted ? `timed out after ${timeoutMs.toString()}ms` : (cause instanceof Error ? cause.message : String(cause));
      await log("failed", detail);
      return { detail, performed: false, reason: aborted ? "timed-out" : "failed" };
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      await log("performed", `HTTP ${response.status.toString()}`);
      return { performed: true, status: response.status };
    }
    // A 3xx with redirect:"manual" is returned un-followed: refuse it. The new
    // host was never approval-vetted nor SSRF-checked, and re-sending a
    // state-changing request (with its body) there is exactly the attack.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "(no location)";
      const detail = `refused to follow redirect to ${location} on a state-changing action (only the original host was vetted)`;
      await log("failed", detail);
      return { detail, performed: false, reason: "failed" };
    }
    // 429-only safe retry (idempotent actuators): the server rate-limited the
    // request BEFORE applying it, so honouring Retry-After can't double-act.
    if (response.status === 429 && attempt < retries) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      await sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, maxRetryAfterMs) : baseDelayMs * 2 ** attempt);
      continue;
    }
    // A non-2xx means the third party REJECTED the action — the booking didn't
    // go through. Reporting that as `performed` would be a false success; a 5xx
    // is AMBIGUOUS and (like a generic web submit) is never retried.
    const detail = `server rejected (HTTP ${response.status.toString()})`;
    await log("failed", detail);
    return { detail, performed: false, reason: "failed" };
  }
}
