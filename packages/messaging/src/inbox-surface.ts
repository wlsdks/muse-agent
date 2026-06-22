/**
 * File-backed InboxContextProvider implementation
 * (Context Engineering Phase 2).
 *
 * Reads each registered provider's persisted inbox file
 * (`appendInbound` populates it from polling daemons / webhooks)
 * and returns the messages newer than the per-source "last injected"
 * cursor. Advances the cursor BEFORE returning so the same message
 * does not show up next turn.
 *
 * Caller wires this into `AgentRuntime.inboxContextProvider`.
 */

import { readInbox } from "./inbox-store.js";
import {
  advanceInboxInjectionCursor,
  readInboxInjectionCursor,
  type InboxInjectionCursor,
  type SourceCursor
} from "./inbox-injection-cursor.js";
import type { InboundMessage } from "./types.js";

export interface InboxSourceConfig {
  readonly providerId: string;
  /** Absolute path to the inbox JSON file written by the daemon. */
  readonly inboxFile: string;
  /** Absolute path to the per-provider cursor file. */
  readonly cursorFile: string;
}

export interface FileBackedInboxContextProviderOptions {
  readonly sources: readonly InboxSourceConfig[];
  /** Per-provider max messages surfaced per resolve. Default 20. */
  readonly perProviderLimit?: number;
  /** Hard cap across all providers in one resolve. Default 80. */
  readonly totalLimit?: number;
}

export interface InboundSummary {
  readonly providerId: string;
  readonly source: string;
  readonly sender?: string;
  readonly receivedAtIso: string;
  readonly text: string;
}

export interface InboxSnapshot {
  readonly messages: readonly InboundSummary[];
  readonly totalByProvider: Readonly<Record<string, number>>;
}

const DEFAULT_PER_PROVIDER_LIMIT = 20;
const DEFAULT_TOTAL_LIMIT = 80;

export class FileBackedInboxContextProvider {
  private readonly sources: readonly InboxSourceConfig[];
  private readonly perProviderLimit: number;
  private readonly totalLimit: number;

  constructor(options: FileBackedInboxContextProviderOptions) {
    this.sources = options.sources;
    this.perProviderLimit = Math.max(1, options.perProviderLimit ?? DEFAULT_PER_PROVIDER_LIMIT);
    this.totalLimit = Math.max(1, options.totalLimit ?? DEFAULT_TOTAL_LIMIT);
  }

  async resolve(userId?: string): Promise<InboxSnapshot | undefined> {
    // Two-phase to avoid silent message loss: first collect fresh
    // messages from every source WITHOUT touching cursors, then apply
    // the total cap, THEN advance cursors only for the surfaced
    // subset. The previous flow advanced cursors before applying the
    // cross-source cap, so messages dropped by the cap were marked
    // "already injected" and were lost forever — never visible to the
    // model on any future turn.
    interface CollectedSource {
      readonly config: InboxSourceConfig;
      readonly fresh: readonly InboundMessage[];
    }
    const collected: CollectedSource[] = [];
    for (const config of this.sources) {
      try {
        const cursor = await readInboxInjectionCursor(config.cursorFile, userId);
        const inbox = await readInbox(config.inboxFile, this.perProviderLimit * 4);
        const fresh = filterFresh(inbox, cursor, this.perProviderLimit);
        if (fresh.length > 0) {
          collected.push({ config, fresh });
        }
      } catch {
        // fail-open per source
      }
    }
    if (collected.length === 0) {
      return undefined;
    }

    // Pass 2: apply the total cap. Round-robin across providers so a
    // single chatty channel cannot starve the others when the cap
    // bites — Slack with 50 fresh + Discord with 5 fresh and a
    // totalLimit of 30 should yield ~25 Slack + 5 Discord, not 30
    // Slack and 0 Discord.
    const surfaced: { readonly providerId: string; readonly message: InboundMessage }[] = [];
    const queues = collected.map((entry) => ({
      messages: [...entry.fresh],
      providerId: entry.config.providerId
    }));
    while (surfaced.length < this.totalLimit) {
      let progressed = false;
      for (const queue of queues) {
        if (surfaced.length >= this.totalLimit) break;
        const next = queue.messages.shift();
        if (!next) continue;
        surfaced.push({ message: next, providerId: queue.providerId });
        progressed = true;
      }
      if (!progressed) break;
    }
    if (surfaced.length === 0) {
      return undefined;
    }

    // Pass 3: advance cursors ONLY for messages we actually surfaced.
    // Group by (providerId, source) so the cursor for a source moves
    // to the newest ISO we actually shipped — not to messages still
    // sitting in the unshipped tail.
    const advanceBySource = new Map<string, { cursorFile: string; advance: Record<string, SourceCursor> }>();
    for (const { message, providerId } of surfaced) {
      const config = collected.find((entry) => entry.config.providerId === providerId)?.config;
      if (!config) continue;
      const bucket = advanceBySource.get(config.cursorFile) ?? {
        advance: {},
        cursorFile: config.cursorFile
      };
      // Track the newest surfaced instant per source AND the set of
      // messageIds surfaced AT that instant, so a second message sharing
      // the boundary timestamp is remembered (and not re-surfaced) while
      // an identical-timestamp message we did NOT ship stays fresh.
      const current = bucket.advance[message.source];
      const mm = Date.parse(message.receivedAtIso);
      const cm = current ? Date.parse(current.iso) : Number.NaN;
      if (!current || (Number.isFinite(mm) && Number.isFinite(cm) && mm > cm) || (!Number.isFinite(cm) && message.receivedAtIso > current.iso)) {
        bucket.advance[message.source] = { ids: [message.messageId], iso: message.receivedAtIso };
      } else if (message.receivedAtIso === current.iso) {
        bucket.advance[message.source] = { ids: [...current.ids, message.messageId], iso: current.iso };
      }
      advanceBySource.set(config.cursorFile, bucket);
    }
    for (const bucket of advanceBySource.values()) {
      try {
        await advanceInboxInjectionCursor(bucket.cursorFile, bucket.advance, userId);
      } catch {
        // fail-open: a cursor write failure means the next turn will
        // re-surface, which is much better than silent loss.
      }
    }

    const totals: Record<string, number> = {};
    for (const entry of surfaced) {
      totals[entry.providerId] = (totals[entry.providerId] ?? 0) + 1;
    }
    return {
      messages: surfaced.map((entry) => toSummary(entry.message)),
      totalByProvider: totals
    };
  }
}

export function filterFresh(
  inbox: readonly InboundMessage[],
  cursor: InboxInjectionCursor,
  perProviderLimit: number
): readonly InboundMessage[] {
  // Compare parsed instants, not raw ISO strings. receivedAtIso is
  // provider-supplied and providers differ in precision/offset
  // (".000Z" vs "Z" vs "+09:00"), so a lexicographic compare both
  // mis-orders AND, worse, can decide a genuinely-newer message is
  // NOT past the cursor — silently dropping a real inbound message.
  // Unparseable values keep a deterministic string order.
  const sorted = [...inbox].sort((a, b) => {
    const am = Date.parse(a.receivedAtIso);
    const bm = Date.parse(b.receivedAtIso);
    if (Number.isFinite(am) && Number.isFinite(bm)) {
      if (am !== bm) {
        return am - bm;
      }
    } else if (a.receivedAtIso !== b.receivedAtIso) {
      return a.receivedAtIso.localeCompare(b.receivedAtIso);
    }
    return a.messageId.localeCompare(b.messageId);
  });
  const fresh = sorted.filter((message) => {
    const last = cursor[message.source];
    if (!last) {
      return true;
    }
    const mm = Date.parse(message.receivedAtIso);
    const lm = Date.parse(last.iso);
    if (Number.isFinite(mm) && Number.isFinite(lm)) {
      if (mm > lm) {
        return true;
      }
      // At the boundary instant a message is fresh ONLY if the cursor
      // tracks surfaced ids at that instant AND this id is not among
      // them — so two distinct messages sharing a receivedAtIso are both
      // eventually delivered, instead of one advancing the cursor past
      // the other (message loss). An EMPTY id set is a legacy/strict
      // boundary: the message at the instant is already-seen (preserving
      // the original `mm > lm` semantics).
      if (mm === lm) {
        return last.ids.length > 0 && !last.ids.includes(message.messageId);
      }
      return false;
    }
    if (message.receivedAtIso > last.iso) {
      return true;
    }
    if (message.receivedAtIso === last.iso) {
      return last.ids.length > 0 && !last.ids.includes(message.messageId);
    }
    return false;
  });
  // Take the OLDEST `perProviderLimit` fresh messages (a contiguous
  // prefix of the ascending-sorted list), NOT the newest. The caller
  // advances the cursor to the newest message it actually surfaces, so
  // surfacing the newest N would jump the cursor past the older fresh
  // messages dropped by the cap — they'd be marked "already injected"
  // and lost forever. A contiguous oldest prefix keeps the unshipped
  // tail strictly newer than the cursor, so it resurfaces next turn.
  return fresh.slice(0, perProviderLimit);
}

function toSummary(message: InboundMessage): InboundSummary {
  return {
    providerId: message.providerId,
    receivedAtIso: message.receivedAtIso,
    sender: message.sender,
    source: message.source,
    text: message.text
  };
}
