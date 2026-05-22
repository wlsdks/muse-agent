/**
 * P16 lifestyle actuator: opt-in Home Assistant smart-home control.
 * Every state-changing service call (turn a light off, lock a door)
 * goes through the SAME fail-closed approval gate as every other
 * outbound/state-changing action (`performWebActionWithApproval`,
 * `outbound-safety.md`): absent an explicit confirm, nothing fires.
 *
 * Home Assistant exposes a local REST API (POST
 * `/api/services/<domain>/<service>`, long-lived Bearer token), so
 * this needs no SDK and works fully local. Banking / payments are NOT
 * a lifestyle actuator and are out of scope.
 */

import { performWebActionWithApproval, type WebActionApprovalGate, type WebActionOutcome, type WebActionRequest } from "./web-action.js";

export interface HomeAssistantServiceCall {
  readonly baseUrl: string;
  readonly token: string;
  readonly domain: string;
  readonly service: string;
  readonly entityId?: string;
  readonly data?: Record<string, unknown>;
}

/**
 * Build the (summary, request) for a Home Assistant service call. Pure
 * so the request shape is testable without HTTP. The service-call body
 * carries `entity_id` (when given) merged with any extra `data`.
 */
export function buildHomeAssistantServiceCall(
  call: HomeAssistantServiceCall
): { readonly summary: string; readonly request: WebActionRequest } {
  const base = call.baseUrl.replace(/\/+$/u, "");
  const payload: Record<string, unknown> = {
    ...(call.entityId ? { entity_id: call.entityId } : {}),
    ...(call.data ?? {})
  };
  return {
    request: {
      body: JSON.stringify(payload),
      headers: { authorization: `Bearer ${call.token}` },
      method: "POST",
      url: `${base}/api/services/${call.domain}/${call.service}`
    },
    summary: `Home Assistant: ${call.domain}.${call.service}${call.entityId ? ` (${call.entityId})` : ""}`
  };
}

export interface PerformHomeActionWithApprovalOptions extends HomeAssistantServiceCall {
  readonly approvalGate: WebActionApprovalGate;
  readonly fetchImpl: typeof fetch;
  readonly actionLogFile: string;
  readonly userId: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly timeoutMs?: number;
}

export async function performHomeActionWithApproval(
  options: PerformHomeActionWithApprovalOptions
): Promise<WebActionOutcome> {
  const { request, summary } = buildHomeAssistantServiceCall(options);
  return performWebActionWithApproval({
    actionLogFile: options.actionLogFile,
    approvalGate: options.approvalGate,
    fetchImpl: options.fetchImpl,
    request,
    summary,
    userId: options.userId,
    ...(options.now ? { now: options.now } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  });
}
