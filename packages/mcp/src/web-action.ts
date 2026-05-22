/**
 * Draft-first, fail-closed agentic web action (P15) — submitting a
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

import { appendActionLog } from "./personal-action-log-store.js";

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
  const log = (result: "performed" | "refused" | "failed", detail: string): Promise<void> =>
    appendActionLog(options.actionLogFile, {
      detail,
      id: idFactory(),
      result,
      userId: options.userId,
      what: `web action: ${options.summary} (${options.request.method ?? "POST"} ${options.request.url})`,
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await options.fetchImpl(options.request.url, {
      method: options.request.method ?? "POST",
      signal: controller.signal,
      ...(options.request.body !== undefined ? { body: options.request.body } : {}),
      headers: {
        ...(options.request.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.request.headers
      }
    });
  } catch (cause) {
    const aborted = controller.signal.aborted;
    const detail = aborted ? `timed out after ${timeoutMs.toString()}ms` : (cause instanceof Error ? cause.message : String(cause));
    await log("failed", detail);
    return { detail, performed: false, reason: aborted ? "timed-out" : "failed" };
  } finally {
    clearTimeout(timer);
  }
  await log("performed", `HTTP ${response.status.toString()}`);
  return { performed: true, status: response.status };
}
