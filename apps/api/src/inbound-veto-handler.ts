import { readLastProactiveDeliveries, recordOutcome } from "@muse/stores";
import { vetoKeyFor } from "@muse/proactivity";

/**
 * Handle an inbound channel message that reads as a bare "stop these
 * notifications" reply — the one-touch off-switch for proactivity (the
 * channel-veto). Returns a confirmation string when matched + recorded, or
 * `undefined` to fall through to the normal agent turn.
 *
 * Deterministic, WHOLE-UTTERANCE matching only ("그만두고 싶다는 생각이 들어" /
 * "should I stop working on this?" must NOT match — a substring hit on "그만"
 * or "stop" would swallow ordinary conversation). A match still requires a
 * proactive delivery within the last 24h (`lastDeliveryFile`, the
 * `interruption-gate` sidecar) — no recent delivery, no veto: there is
 * nothing on record to silence, and guessing would be worse than doing
 * nothing.
 *
 * The recorded key is `vetoKeyFor(lastDelivery.sourceKey)` — instance-level
 * for a recurring source (pattern/ambient/checkin), kind-level for a
 * one-shot source (followup/background-exit) whose id never recurs (see
 * `veto-key.ts`'s doc comment). `interruption-gate.ts`'s `isVetoed` matches
 * both forms, so either recording silences the right future notices.
 *
 * Fail-CLOSED on the write: a ledger-append error returns `undefined`, never
 * a confirmation — telling the user "I won't send those again" for a veto
 * that was NOT actually recorded would be a lie the next notice disproves.
 */

const KO_STOP_PHRASES: ReadonlySet<string> = new Set([
  "그만",
  "그만해",
  "알림 그만",
  "알림 꺼",
  "이런 알림 그만",
  "이런 거 그만"
]);

const EN_STOP_PHRASES: ReadonlySet<string> = new Set([
  "stop",
  "stop these",
  "stop this",
  "mute this",
  "no more of these"
]);

const VETO_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Trim + collapse internal whitespace + drop TRAILING punctuation/whitespace
 * only — never internal characters, so "그만ㅋㅋ" (a laugh, not punctuation)
 * stays untouched and correctly fails to match any stop phrase below.
 */
function normalizeUtterance(text: string): string {
  const collapsed = text.trim().replace(/\s+/gu, " ");
  return collapsed.replace(/[\s!?.~,。！？]+$/u, "");
}

/** Whole-utterance match only — a stop phrase embedded in a longer sentence
 *  ("그만두고 싶다는 생각이 들어", "should I stop working on this?") is NOT a veto. */
export function isVetoUtterance(text: string): boolean {
  const normalized = normalizeUtterance(text);
  if (normalized.length === 0) return false;
  return KO_STOP_PHRASES.has(normalized) || EN_STOP_PHRASES.has(normalized.toLowerCase());
}

export interface HandleInboundVetoReplyOptions {
  readonly text: string;
  /** The `interruption-gate` last-delivery sidecar (`@muse/stores`). */
  readonly lastDeliveryFile: string;
  /** The proactive-trust ledger (`@muse/stores`) — the veto record lands here. */
  readonly trustLedgerFile: string;
  readonly now: Date;
}

export async function handleInboundVetoReply(
  options: HandleInboundVetoReplyOptions
): Promise<string | undefined> {
  if (!isVetoUtterance(options.text)) {
    return undefined;
  }
  const deliveries = await readLastProactiveDeliveries(options.lastDeliveryFile);
  if (deliveries.length === 0) {
    return undefined;
  }
  // Append-order, oldest-first (last-proactive-delivery-store.ts) — the most
  // recent delivery is the last entry.
  const latest = deliveries[deliveries.length - 1]!;
  const deliveredAtMs = Date.parse(latest.at);
  if (!Number.isFinite(deliveredAtMs) || options.now.getTime() - deliveredAtMs > VETO_WINDOW_MS) {
    return undefined;
  }
  const key = vetoKeyFor(latest.sourceKey);
  try {
    await recordOutcome(options.trustLedgerFile, key, "vetoed", options.now.getTime());
  } catch {
    // Fail-CLOSED: the veto was NOT recorded, so no confirmation is sent —
    // a false "I won't send those again" is worse than silently falling
    // through to the normal agent turn.
    return undefined;
  }
  // `vetoKeyFor` returns the kind alone (no ":") for a kind-level veto, the
  // full sourceKey (still `${kind}:${id}`, so ":"-joined) for an
  // instance-level one — no kind string in use contains a colon itself.
  const scopeIsKindLevel = !key.includes(":");
  const scope = scopeIsKindLevel
    ? "이런 종류의 알림은 이제 안 보낼게"
    : `'${latest.title ?? latest.sourceKey}' 알림은 이제 안 보낼게`;
  return `알겠어 — ${scope}. 되돌리려면: muse proactive keep ${key}`;
}
