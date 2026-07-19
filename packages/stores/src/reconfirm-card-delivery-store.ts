/**
 * A small sidecar recording the LAST reconfirm question actually PUSHED to
 * the paired channel via the day-rhythm morning briefing (slotId +
 * deliveredAt). The channel reply handler
 * (`apps/api/src/inbound-reconfirm-handler.ts`) consults this to decide
 * whether a bare "맞아"/"아니야" reply refers to a real, recently-asked
 * question — same "what did Muse just send me" shape as
 * `last-proactive-delivery-store.ts`, but scoped to the ONE reconfirm slot
 * (never a list — at most one reconfirm question is pushed per day).
 *
 * Sibling of `reconfirm-card-answered-store.ts` (the separate "already
 * answered TODAY" per-day gate, shared with the Home pull card) — this file
 * only ever records WHAT was delivered and WHEN, never whether it was
 * answered.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile } from "./atomic-file-store.js";

export interface ReconfirmCardDeliveryState {
  readonly slotId: string;
  /** ISO timestamp of the delivery. */
  readonly deliveredAt: string;
}

function isReconfirmCardDeliveryState(value: unknown): value is ReconfirmCardDeliveryState {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.slotId === "string" && entry.slotId.length > 0
    && typeof entry.deliveredAt === "string" && !Number.isNaN(Date.parse(entry.deliveredAt));
}

/** The last recorded reconfirm-question delivery, or `undefined` when never
 *  delivered / the sidecar is missing / unreadable / malformed. */
export async function readReconfirmCardDelivery(file: string): Promise<ReconfirmCardDeliveryState | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  return isReconfirmCardDeliveryState(parsed) ? parsed : undefined;
}

/** Record that `slotId`'s reconfirm question was pushed at `at`. Overwrites
 *  any prior delivery — only the MOST RECENT one is ever relevant to the
 *  reply window. */
export async function markReconfirmCardDelivered(file: string, slotId: string, at: Date): Promise<void> {
  const state: ReconfirmCardDeliveryState = { deliveredAt: at.toISOString(), slotId };
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when `state` is on record AND `at` is within `windowMs` (default 24h)
 * of `state.deliveredAt` — mirrors `handleInboundVetoReply`'s exact recency
 * check (`inbound-veto-handler.ts`): a stale or absent delivery must never
 * let a bare "맞아"/"아니야" be mistaken for an answer to a question Muse
 * didn't just ask.
 */
export function isReconfirmCardDeliveryRecent(
  state: ReconfirmCardDeliveryState | undefined,
  at: Date,
  windowMs: number = DEFAULT_WINDOW_MS
): boolean {
  if (!state) return false;
  const deliveredAtMs = Date.parse(state.deliveredAt);
  if (!Number.isFinite(deliveredAtMs)) return false;
  return at.getTime() - deliveredAtMs <= windowMs;
}
