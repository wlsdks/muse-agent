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

import { fetchWithRetry, type RetryOptions } from "./http-retry.js";
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

export interface HomeStateQuery {
  readonly baseUrl: string;
  readonly token: string;
  readonly entityId: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly retryOptions?: RetryOptions;
}

export interface HomeState {
  readonly entityId: string;
  readonly state: string;
  readonly attributes: Record<string, unknown>;
}

/**
 * Read a Home Assistant entity's current state (GET `/api/states/<id>`)
 * so Muse can answer "is the front door locked?" / "living-room
 * temperature?". A read is non-state-changing and idempotent, so it's
 * retry-hardened against transient 429/5xx (unlike the write path,
 * which must stay single-shot). Returns `undefined` — never throws —
 * on a permanent failure or a malformed body, so the caller degrades
 * gracefully instead of crashing the turn.
 */
export async function readHomeAssistantState(query: HomeStateQuery): Promise<HomeState | undefined> {
  const base = query.baseUrl.replace(/\/+$/u, "");
  const url = `${base}/api/states/${encodeURIComponent(query.entityId)}`;
  const fetchImpl = query.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchWithRetry(fetchImpl, url, {
      ...(query.retryOptions ?? {}),
      init: { headers: { authorization: `Bearer ${query.token}` } }
    });
  } catch {
    return undefined;
  }
  if (!response.ok) {
    return undefined;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.state !== "string") {
    return undefined;
  }
  const attributes = obj.attributes && typeof obj.attributes === "object" && !Array.isArray(obj.attributes)
    ? obj.attributes as Record<string, unknown>
    : {};
  return { attributes, entityId: query.entityId, state: obj.state };
}

/**
 * Adapt a Home Assistant entity into the web-watch snapshot contract:
 * a `() => Promise<string | undefined>` that returns the entity's
 * current `state` string (e.g. "locked", "21.4"). Lets the proven
 * web-watch runner/detector monitor a home sensor exactly as it
 * monitors a web page — "ping me if the door is unlocked / the freezer
 * rises above -15". Returns `undefined` (skip, keep baseline) when the
 * read fails.
 */
export function createHomeStateSnapshot(query: HomeStateQuery): () => Promise<string | undefined> {
  return async () => {
    const state = await readHomeAssistantState(query);
    return state?.state;
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
