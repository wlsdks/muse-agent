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

import { fetchWithRetry, type RetryOptions } from "@muse/mcp-shared";
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

export interface HomeEntitiesQuery {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly retryOptions?: RetryOptions;
  /** Optional domain filter, e.g. "light" / "lock" — only entities whose id starts with `<domain>.`. */
  readonly domain?: string;
}

/**
 * Discover Home Assistant entities (GET `/api/states`) so the agent can
 * answer "what devices do I have?" and find the entity ids that
 * `home_state` / `home_action` need. Read-only + retry-hardened.
 * Optional `domain` filters to one type (`light.`, `lock.`, …). Returns
 * `[]` — never throws — on failure or a malformed body.
 */
export async function listHomeAssistantStates(query: HomeEntitiesQuery): Promise<HomeState[]> {
  const base = query.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = query.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchWithRetry(fetchImpl, `${base}/api/states`, {
      ...(query.retryOptions ?? {}),
      init: { headers: { authorization: `Bearer ${query.token}` } }
    });
  } catch {
    return [];
  }
  if (!response.ok) {
    return [];
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  if (!Array.isArray(body)) {
    return [];
  }
  const domain = query.domain?.replace(/\.$/u, "").trim();
  const prefix = domain && domain.length > 0 ? `${domain}.` : undefined;
  const out: HomeState[] = [];
  for (const item of body) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const o = item as Record<string, unknown>;
    if (typeof o.entity_id !== "string" || typeof o.state !== "string") {
      continue;
    }
    if (prefix && !o.entity_id.startsWith(prefix)) {
      continue;
    }
    const attributes = o.attributes && typeof o.attributes === "object" && !Array.isArray(o.attributes)
      ? o.attributes as Record<string, unknown>
      : {};
    out.push({ attributes, entityId: o.entity_id, state: o.state });
  }
  return out;
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

export interface HomeAlertCheck {
  readonly entityId: string;
  readonly label: string;
  /** States worth surfacing in a briefing (e.g. ["unlocked", "open"]). */
  readonly alertStates: readonly string[];
}

/**
 * Parse a JSON array of home-alert checks from config. Each entry needs
 * a non-empty `entityId` + `label` and a non-empty `alertStates`
 * string array. Fail-open: malformed JSON / non-array / an invalid
 * entry is skipped.
 */
export function parseHomeAlertChecks(raw: string): HomeAlertCheck[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: HomeAlertCheck[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.entityId !== "string" || e.entityId.length === 0 || typeof e.label !== "string" || e.label.length === 0) {
      continue;
    }
    if (!Array.isArray(e.alertStates)) {
      continue;
    }
    const alertStates = e.alertStates.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (alertStates.length === 0) {
      continue;
    }
    out.push({ alertStates, entityId: e.entityId, label: e.label });
  }
  return out;
}

export interface HomeAlertConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly retryOptions?: RetryOptions;
}

/**
 * Read each configured entity and surface ONLY the ones in a
 * noteworthy state (door unlocked, window open) as a one-line briefing
 * fragment — "Front door is unlocked; Garage is open". Returns
 * `undefined` when nothing is noteworthy (or every read fails), so the
 * briefing stays quiet rather than narrating "everything's normal".
 * A per-entity read failure is skipped, never thrown.
 */
export async function resolveHomeAlertLine(
  connection: HomeAlertConnection,
  checks: readonly HomeAlertCheck[]
): Promise<string | undefined> {
  const alerts: string[] = [];
  for (const check of checks) {
    const state = await readHomeAssistantState({
      baseUrl: connection.baseUrl,
      entityId: check.entityId,
      token: connection.token,
      ...(connection.fetchImpl ? { fetchImpl: connection.fetchImpl } : {}),
      ...(connection.retryOptions ? { retryOptions: connection.retryOptions } : {})
    });
    if (state === undefined) {
      continue;
    }
    const current = state.state.toLowerCase();
    if (check.alertStates.some((s) => s.toLowerCase() === current)) {
      alerts.push(`${check.label} is ${state.state}`);
    }
  }
  return alerts.length > 0 ? alerts.join("; ") : undefined;
}

export interface PerformHomeActionWithApprovalOptions extends HomeAssistantServiceCall {
  readonly approvalGate: WebActionApprovalGate;
  readonly fetchImpl: typeof fetch;
  readonly actionLogFile: string;
  readonly userId: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly timeoutMs?: number;
  /** 429 retry budget (extra attempts). Default 2. */
  readonly retries?: number;
  /** Injectable delay so tests don't wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
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
    // A Home Assistant `call_service` (set a state) is idempotent and a 429 is
    // rejected before it applies, so the home actuator opts into the 429-only
    // safe retry — unlike a generic non-idempotent web submit.
    retryOn429: true,
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  });
}
