/**
 * Daily digest flush — the counterpart to `interruption-gate.ts`'s suppressed
 * path. Once a day, at `digestHour` local time, compiles whatever landed in
 * the digest queue into ONE message and sends it; the compile is a verbatim
 * concatenation of each item's already-gated text (no LLM — same "no new
 * fabrication surface" invariant the queue itself documents).
 *
 * SNAPSHOT DRAIN: `readDigestQueue` is read exactly once (the snapshot);
 * the compiled message is built from that snapshot; on a successful send the
 * queue is drained with `upToAt` set to the MAX `at` among the RENDERED
 * items ONLY — never the whole snapshot. When the snapshot overflows the
 * safe length, `compileDigestMessage` renders the OLDEST items whole (FIFO —
 * longest-waiting first) and folds the NEWEST overflow items into one
 * trailing summary line; those folded items are NOT drained (their `at` is
 * strictly greater than `upToAt`), so they stay queued and flush honestly on
 * a later day instead of being silently deleted un-delivered. Anything
 * appended to the queue while this flush is compiling/sending carries a
 * strictly later `at` still (interruption-gate stamps `at` at gate-call
 * time) and survives the drain the same way. A send failure drains nothing —
 * the queue is preserved for the next tick.
 */

import { errorMessage } from "@muse/shared";
import type { MessagingProviderRegistry } from "@muse/messaging";
import {
  digestAlreadySentToday,
  drainDigestQueue,
  markDigestSent,
  readDigestQueue,
  type DigestQueueItem
} from "@muse/stores";

import { sendWithRetry } from "@muse/mcp-shared";

export const DEFAULT_DIGEST_HOUR = 18;

// A conservative ceiling comfortably under the tightest known provider
// outbound clamp (Discord's 2000, `clampOutboundText` in @muse/messaging) so
// the digest never rides a provider-level mid-line truncation — overflow is
// handled here, one whole line at a time, before that clamp would ever bite.
const DIGEST_SAFE_LENGTH = 1800;

/** One digest line — reused by `muse digest list` so the CLI preview matches the flush verbatim. */
export function formatDigestItemLine(item: DigestQueueItem): string {
  const at = new Date(item.at);
  const hh = at.getHours().toString().padStart(2, "0");
  const mm = at.getMinutes().toString().padStart(2, "0");
  return `· [${item.source}] ${hh}:${mm} ${item.text}`;
}

export interface CompiledDigest {
  readonly text: string;
  /**
   * The MAX `at` among the RENDERED items only (never a folded-overflow
   * item) — the drain cutoff. Composes correctly with `drainDigestQueue`'s
   * at-based cutoff: rendered items are strictly ≤ this, folded items are
   * strictly greater, so drain(upToAt) removes exactly what the message
   * actually said and never a summarized-away item.
   */
  readonly upToAt: Date;
}

function maxAtMs(items: readonly DigestQueueItem[]): number {
  return Math.max(...items.map((item) => new Date(item.at).getTime()));
}

function minAtMs(items: readonly DigestQueueItem[]): number {
  return Math.min(...items.map((item) => new Date(item.at).getTime()));
}

/**
 * Compile a digest-queue snapshot into one message. `items` is queue order
 * (oldest first). When the full rendering exceeds `maxLength`, this is FIFO:
 * the OLDEST items render whole (longest-waiting first) and the NEWEST
 * overflow items fold into one trailing summary line — never a mid-line
 * truncation. `upToAt` bounds to the rendered items only, so a caller that
 * drains up to `upToAt` never deletes a folded (un-rendered) item — it stays
 * queued and gets its turn (rendered, or itself the oldest) on a later flush.
 */
export function compileDigestMessage(
  items: readonly DigestQueueItem[],
  options: { readonly maxLength?: number } = {}
): CompiledDigest {
  const maxLength = options.maxLength ?? DIGEST_SAFE_LENGTH;
  const header = `오늘 조용히 모아둔 소식 ${items.length.toString()}건`;
  const lines = items.map(formatDigestItemLine);
  const full = [header, ...lines].join("\n");
  if (full.length <= maxLength || items.length <= 1) {
    return { text: full, upToAt: new Date(maxAtMs(items)) };
  }
  for (let dropped = 1; dropped <= items.length; dropped += 1) {
    const keepCount = items.length - dropped;
    const kept = lines.slice(0, keepCount);
    const overflowLine = `· …and ${dropped.toString()} more (see muse digest)`;
    const candidate = [header, ...kept, overflowLine].join("\n");
    if (candidate.length <= maxLength || dropped === items.length) {
      // keepCount === 0 means NOTHING was individually rendered (only
      // possible with a pathologically tiny maxLength) — drain nothing by
      // setting the cutoff strictly before the earliest item.
      const upToAt = keepCount > 0
        ? new Date(maxAtMs(items.slice(0, keepCount)))
        : new Date(minAtMs(items) - 1);
      return { text: candidate, upToAt };
    }
  }
  // Unreachable — the loop above always returns by `dropped === items.length`.
  return { text: full, upToAt: new Date(maxAtMs(items)) };
}

export interface RunDigestFlushOptions {
  readonly digestFile: string;
  readonly sentFile: string;
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  /** Local hour the digest fires at. Default 18 (`DEFAULT_DIGEST_HOUR`). */
  readonly digestHour?: number;
  readonly now?: () => Date;
}

export type RunDigestFlushOutcome = "not-due" | "already-sent-today" | "empty" | "sent" | "send-failed";

export interface RunDigestFlushSummary {
  readonly outcome: RunDigestFlushOutcome;
  readonly itemCount: number;
  readonly errors: readonly string[];
}

/**
 * Run one digest-flush check. The caller is responsible for the quiet-hours
 * gate (same convention as every sibling tick — `isQuietHour` wraps the call,
 * it's never threaded through the run function itself).
 */
export async function runDigestFlushIfDue(options: RunDigestFlushOptions): Promise<RunDigestFlushSummary> {
  const now = (options.now ?? (() => new Date()))();
  const digestHour = options.digestHour ?? DEFAULT_DIGEST_HOUR;
  if (now.getHours() !== digestHour) {
    return { errors: [], itemCount: 0, outcome: "not-due" };
  }

  // Fail-open on a corrupt/unreadable sidecar: never let a broken "already
  // sent" marker permanently silence the daily flush (§4 of the plan).
  let alreadySent: boolean;
  try {
    alreadySent = await digestAlreadySentToday(options.sentFile, now);
  } catch (cause) {
    return runFlushAfterSentCheck(options, now, [`digest-flush: sent-sidecar read failed, proceeding: ${errorMessage(cause)}`]);
  }
  if (alreadySent) {
    return { errors: [], itemCount: 0, outcome: "already-sent-today" };
  }
  return runFlushAfterSentCheck(options, now, []);
}

async function runFlushAfterSentCheck(
  options: RunDigestFlushOptions,
  now: Date,
  priorErrors: readonly string[]
): Promise<RunDigestFlushSummary> {
  const errors = [...priorErrors];
  // The snapshot: everything read here is what this message is ABOUT (the
  // header's "N건" count), but the drain below removes only the individually
  // RENDERED items — a folded-overflow item is not drained (see
  // `compileDigestMessage`'s `upToAt`) and survives for a later flush.
  const items = await readDigestQueue(options.digestFile);
  if (items.length === 0) {
    return { errors, itemCount: 0, outcome: "empty" };
  }

  const { text, upToAt } = compileDigestMessage(items);
  try {
    await sendWithRetry(options.registry, options.providerId, { destination: options.destination, text });
  } catch (cause) {
    errors.push(`digest-flush: send failed, queue preserved: ${errorMessage(cause)}`);
    return { errors, itemCount: items.length, outcome: "send-failed" };
  }

  try {
    await drainDigestQueue(options.digestFile, upToAt);
  } catch (cause) {
    errors.push(`digest-flush: drain failed after a successful send: ${errorMessage(cause)}`);
  }
  try {
    await markDigestSent(options.sentFile, now);
  } catch (cause) {
    errors.push(`digest-flush: sent-sidecar mark failed (may re-fire next tick): ${errorMessage(cause)}`);
  }
  return { errors, itemCount: items.length, outcome: "sent" };
}
