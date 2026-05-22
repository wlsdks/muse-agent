/**
 * Web-watch trigger detection (P21). The core of "monitor this page
 * and ping me when X" — given the previous and current text snapshot
 * of a page (e.g. from Chrome DevTools MCP `take_snapshot`), decide
 * whether the watch condition just became true. Edge-triggered so a
 * standing condition doesn't re-fire every poll.
 *
 * Pure string logic — no deps; the polling tick (snapshot via the
 * MCP tool + deliver a proactive notice) wires this in.
 */
import type { ProactiveNoticeSink } from "./proactive-notice-loop.js";

export interface WatchRule {
  /** Fire when the snapshot NEWLY contains this (wasn't there before). */
  readonly appears?: string;
  /** Fire when the snapshot NEWLY lacks this (was there before). */
  readonly disappears?: string;
  /** Fire on ANY content change vs the previous snapshot. */
  readonly onAnyChange?: boolean;
  /** Case-insensitive substring matching. Default true. */
  readonly caseInsensitive?: boolean;
}

export interface WatchTrigger {
  readonly triggered: boolean;
  readonly reason?: string;
}

function includesText(haystack: string, needle: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle);
}

/**
 * `previousText` is undefined on the first observation (no baseline):
 * `appears` fires if the term is present now (the user learns it's
 * there); `disappears` / `onAnyChange` need a baseline and stay quiet.
 */
export function detectWatchTrigger(
  previousText: string | undefined,
  currentText: string,
  rule: WatchRule
): WatchTrigger {
  const caseInsensitive = rule.caseInsensitive !== false;

  if (rule.appears !== undefined && rule.appears.length > 0) {
    const presentNow = includesText(currentText, rule.appears, caseInsensitive);
    const presentBefore = previousText !== undefined && includesText(previousText, rule.appears, caseInsensitive);
    if (presentNow && !presentBefore) {
      return { reason: `appeared: ${rule.appears}`, triggered: true };
    }
  }

  if (rule.disappears !== undefined && rule.disappears.length > 0) {
    const presentNow = includesText(currentText, rule.disappears, caseInsensitive);
    const presentBefore = previousText !== undefined && includesText(previousText, rule.disappears, caseInsensitive);
    if (presentBefore && !presentNow) {
      return { reason: `gone: ${rule.disappears}`, triggered: true };
    }
  }

  if (rule.onAnyChange === true && previousText !== undefined && previousText !== currentText) {
    return { reason: "content changed", triggered: true };
  }

  return { triggered: false };
}

export interface WebWatch {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly rule: WatchRule;
  /** Fetch the current page text — in production a Chrome DevTools MCP `take_snapshot` call. */
  readonly snapshot: () => Promise<string | undefined> | string | undefined;
}

export interface WebWatchRunner {
  tick(): Promise<{ readonly delivered: number }>;
}

/**
 * Stateful web-watch runner for a polling tick. Each tick snapshots
 * every watch's page, runs {@link detectWatchTrigger} against that
 * watch's previous snapshot, and delivers a proactive notice on a
 * trigger. Holds the per-watch baseline so the detector is
 * edge-triggered across ticks. A failed snapshot is skipped WITHOUT
 * losing the last good baseline. Read-only: a watch never acts.
 */
export function createWebWatchRunner(options: {
  readonly watches: readonly WebWatch[];
  readonly sink: ProactiveNoticeSink;
}): WebWatchRunner {
  const previous = new Map<string, string>();
  return {
    async tick(): Promise<{ readonly delivered: number }> {
      let delivered = 0;
      for (const watch of options.watches) {
        let current: string | undefined;
        try {
          current = await watch.snapshot();
        } catch {
          current = undefined;
        }
        if (current === undefined) {
          continue;
        }
        const trigger = detectWatchTrigger(previous.get(watch.id), current, watch.rule);
        previous.set(watch.id, current);
        if (trigger.triggered) {
          await options.sink.deliver({
            kind: "web-watch",
            text: trigger.reason ? `${watch.message} (${trigger.reason})` : watch.message,
            title: watch.title
          });
          delivered += 1;
        }
      }
      return { delivered };
    }
  };
}
