import { findUserModelSlotById, reviveUserModelSlotDates, type UserModelSlot } from "@muse/memory";
import {
  isReconfirmCardDeliveryRecent,
  markReconfirmCardAnswered,
  reconfirmCardAlreadyAnsweredToday,
  readReconfirmCardDelivery
} from "@muse/stores";

import type { UserModelReconfirmMemoryStore } from "./user-model-reconfirm-routes.js";

/**
 * Handle an inbound channel message that reads as a bare "맞아"/"아니야"
 * answer to the day's PUSHED "Muse가 확인하고 싶은 것" question (the
 * day-rhythm morning briefing's reconfirm addendum, appended by
 * `apps/cli/src/daemon-delivery-ticks.ts`'s `makeBriefingTick`). Returns a
 * confirmation string when matched + applied, or `undefined` to fall
 * through to the normal agent turn.
 *
 * Deterministic, WHOLE-UTTERANCE matching only — same discipline as
 * `inbound-veto-handler.ts`'s `isVetoUtterance`: "아니야 그거 말고 다른 얘기"
 * (a multi-clause sentence that merely CONTAINS "아니야") must NOT match, or
 * ordinary conversation would be swallowed as a reconfirm answer.
 *
 * A match still requires ALL of:
 *   - a reconfirm question delivered within the last 24h
 *     (`reconfirm-card-delivery-store.ts`) — no recent delivery, no answer:
 *     there is nothing on record this reply could be answering, and
 *     guessing would risk mutating the user model from an UNRELATED "아니야"
 *     in normal chat.
 *   - the day's per-day gate still open (`reconfirm-card-answered-store.ts`,
 *     SHARED with the Home pull card — answered anywhere is done everywhere).
 *   - the delivered slotId still resolves to a real slot (it may have been
 *     confirmed/rejected already via the web card, or removed).
 *
 * The mutation is byte-identical to the Home card's POST route
 * (`user-model-reconfirm-routes.ts`): confirm clears `confidence` + bumps
 * `updatedAt` (re-assert, stops decaying); reject removes the slot. A
 * mutation-write failure falls through WITHOUT an ack — a false "got it,
 * noted" for a write that didn't actually happen is worse than silence.
 */

const CONFIRM_PHRASES: ReadonlySet<string> = new Set(["맞아", "맞아요", "응 맞아"]);
const REJECT_PHRASES: ReadonlySet<string> = new Set(["아니야", "아니에요", "틀려"]);

const CONFIRM_ACK = "고마워요 — 반영했어요.";
const REJECT_ACK = "알려줘서 고마워요 — 다시 추측하지 않을게요.";

/**
 * Trim + collapse internal whitespace + drop TRAILING punctuation/whitespace
 * only — same discipline as `inbound-veto-handler.ts`'s `normalizeUtterance`
 * so "아니야ㅋㅋ" (a laugh, not punctuation) stays untouched and correctly
 * fails to match.
 */
function normalizeUtterance(text: string): string {
  const collapsed = text.trim().replace(/\s+/gu, " ");
  return collapsed.replace(/[\s!?.~,。！？]+$/u, "");
}

/** Whole-utterance match only — a bare "맞아"/"아니야" embedded in a longer
 *  sentence is NOT a reconfirm answer. `undefined` when the text matches
 *  neither closed set. */
export function classifyReconfirmReplyUtterance(text: string): "confirm" | "reject" | undefined {
  const normalized = normalizeUtterance(text);
  if (normalized.length === 0) return undefined;
  if (CONFIRM_PHRASES.has(normalized)) return "confirm";
  if (REJECT_PHRASES.has(normalized)) return "reject";
  return undefined;
}

export interface HandleInboundReconfirmReplyOptions {
  readonly text: string;
  readonly userMemoryStore: UserModelReconfirmMemoryStore | undefined;
  readonly defaultUserId: string;
  /** `reconfirm-card-delivery-store.ts` sidecar the briefing tick writes. */
  readonly deliveryFile: string;
  /** `reconfirm-card-answered-store.ts` sidecar — SHARED with the Home card. */
  readonly answeredFile: string;
  readonly now: Date;
}

export async function handleInboundReconfirmReply(
  options: HandleInboundReconfirmReplyOptions
): Promise<string | undefined> {
  const verdict = classifyReconfirmReplyUtterance(options.text);
  if (!verdict) {
    return undefined;
  }
  if (!options.userMemoryStore) {
    return undefined;
  }

  const delivery = await readReconfirmCardDelivery(options.deliveryFile).catch(() => undefined);
  if (!isReconfirmCardDeliveryRecent(delivery, options.now)) {
    return undefined;
  }

  const alreadyAnswered = await reconfirmCardAlreadyAnsweredToday(options.answeredFile, options.now).catch(() => false);
  if (alreadyAnswered) {
    return undefined;
  }

  const snap = await Promise.resolve(options.userMemoryStore.findByUserId(options.defaultUserId)).catch(() => undefined);
  const model = snap?.userModel ? reviveUserModelSlotDates(snap.userModel) : undefined;
  const slot = model ? findUserModelSlotById(model, delivery!.slotId) : undefined;
  if (!slot) {
    return undefined;
  }

  try {
    if (verdict === "reject") {
      await options.userMemoryStore.removeUserModelSlot?.(options.defaultUserId, slot.id);
    } else {
      const { confidence: _wasInferred, ...rest } = slot;
      const asserted = { ...rest, updatedAt: options.now } as UserModelSlot;
      await options.userMemoryStore.upsertUserModelSlot?.(options.defaultUserId, asserted);
    }
    await markReconfirmCardAnswered(options.answeredFile, options.now);
  } catch {
    // Fail-CLOSED: the mutation (or the answered-mark) did NOT land, so no
    // ack is sent — mirrors `handleInboundVetoReply`'s same discipline.
    return undefined;
  }

  return verdict === "confirm" ? CONFIRM_ACK : REJECT_ACK;
}
