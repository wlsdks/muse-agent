/**
 * Proactive home monitoring — compose the Home Assistant state read
 * (`createHomeStateSnapshot`) with the proven web-watch runner/detector
 * so Muse can "ping me if the front door is left unlocked" or "if the
 * freezer rises above -15". A home-watch is just a `WebWatch` whose
 * snapshot is an HA entity's `state`, so the SAME edge-triggered
 * detector, numeric `below`/`above`, and `ProactiveNoticeSink` apply —
 * no parallel machinery. Read-only perception; a watch NEVER actuates
 * (outbound-safety).
 */

import type { RetryOptions } from "@muse/mcp-shared";
import { createHomeStateSnapshot } from "./smart-home.js";
import { parseWatchRule, type WebWatch } from "@muse/proactivity";

export interface HomeWatchConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly retryOptions?: RetryOptions;
}

/**
 * Parse a JSON array of home-watch specs into runnable `WebWatch`es
 * over Home Assistant entity states. Each entry needs a non-empty `id`
 * + `entityId`, string `title`/`message`, and a `rule` with at least
 * one firing condition (shared `parseWatchRule`). The HA `baseUrl` /
 * `token` come from the connection (shared creds), not per-entry.
 * Fail-open: malformed JSON / non-array / an invalid entry is skipped.
 */
export function homeWatchesFromConfig(raw: string, connection: HomeWatchConnection): WebWatch[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: WebWatch[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0 || typeof e.entityId !== "string" || e.entityId.length === 0) {
      continue;
    }
    if (typeof e.title !== "string" || typeof e.message !== "string") {
      continue;
    }
    const rule = parseWatchRule(e.rule);
    if (rule === undefined) {
      continue;
    }
    out.push({
      id: e.id,
      message: e.message,
      rule,
      snapshot: createHomeStateSnapshot({
        baseUrl: connection.baseUrl,
        entityId: e.entityId,
        token: connection.token,
        ...(connection.fetchImpl ? { fetchImpl: connection.fetchImpl } : {}),
        ...(connection.retryOptions ? { retryOptions: connection.retryOptions } : {})
      }),
      title: e.title
    });
  }
  return out;
}
