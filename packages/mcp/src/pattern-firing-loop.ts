/**
 * Pattern-detection firing engine — step 4 wiring half of
 * `docs/design/pattern-detection.md`. The orchestrator from
 * `@muse/memory`'s `selectFireablePatterns` already decides
 * *which* patterns should fire on a given tick; this engine
 * delivers them.
 *
 * Steps per tick:
 *   1. `aggregateActivitySignals(...)` over the user's local files.
 *   2. `readPatternsFired(...)` for the cooldown index.
 *   3. `selectFireablePatterns(now, signals, fired, options)` to
 *      get the actionable subset.
 *   4. For each match: `messagingRegistry.send` the suggestion
 *      text, then `recordPatternFired(...)` so the next tick
 *      respects the cooldown.
 *   5. Optionally publish each delivered notice to the Phase D
 *      `AgentInitiatedNoticeBroker` for live SSE subscribers.
 *
 * Pure data-only function — `registry`, `now`, and all paths are
 * injected so tests run without a real messenger or filesystem
 * outside the test's own tmpdir. v0 delivers the detector's
 * `suggestion` field verbatim; LLM-composed Phase D synthesis (the
 * way reminders do it via `ProactiveModelProviderLike`) can land
 * in a follow-up iter once the proactive-pattern flow is
 * dogfooded.
 */

import {
  aggregateActivitySignals,
  selectFireablePatterns,
  type AggregateActivitySignalsOptions,
  type PatternMatch,
  type SelectFireablePatternsOptions
} from "@muse/memory";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { sendWithRetry } from "./messaging-retry.js";
import { isPatternDismissed, isPatternOnCooldown, readPatternsFired, recordPatternFired } from "@muse/stores";
import type { AgentInitiatedNoticeBrokerLike } from "./proactive-notice-loop.js";

export interface RunDuePatternNoticesOptions {
  /** Where to read the cooldown sidecar from. Required. */
  readonly patternsFiredFile: string;
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  /** Forwarded to `aggregateActivitySignals`. Defaults documented there. */
  readonly signals?: AggregateActivitySignalsOptions;
  /** Forwarded to `selectFireablePatterns`. Default cooldown 24h, min-confidence 0.7. */
  readonly select?: SelectFireablePatternsOptions;
  readonly now?: () => Date;
  /**
   * Optional LLM synthesis of the suggestion text (the deferred "Phase D
   * synthesis"). Given the fireable match, return a composed suggestion or
   * undefined to keep the detector's verbatim `match.suggestion`. Kept as a
   * callback so this loop stays free of any model dependency — the daemon
   * supplies one backed by `synthesizePatternSuggestion`.
   */
  readonly composeSuggestion?: (match: PatternMatch) => Promise<string | undefined>;
  /**
   * Phase D fan-out. Both must be set for the broker leg to fire;
   * the messaging-send leg always runs.
   */
  readonly agentInitiatedNoticeBroker?: AgentInitiatedNoticeBrokerLike;
  readonly agentInitiatedNoticeUserId?: string;
}

export interface RunDuePatternNoticesSummary {
  readonly fireable: number;
  readonly delivered: number;
  readonly errors: readonly string[];
  readonly fired: readonly PatternMatch[];
}

export async function runDuePatternNotices(options: RunDuePatternNoticesOptions): Promise<RunDuePatternNoticesSummary> {
  const now = options.now ?? (() => new Date());
  const signals = await aggregateActivitySignals({
    now: () => now().getTime(),
    ...(options.signals ?? {})
  });
  const firedRecords = await readPatternsFired(options.patternsFiredFile);
  const fireable = selectFireablePatterns(now(), signals, firedRecords, options.select ?? {});

  if (fireable.length === 0) {
    return { delivered: 0, errors: [], fireable: 0, fired: [] };
  }

  const errors: string[] = [];
  const fired: PatternMatch[] = [];
  let delivered = 0;

  // The orchestrator already filtered cooldown ones out, but a
  // pathological caller passing stale fired-records could let one
  // through. Double-check inline so a buggy caller cannot
  // accidentally re-spam.
  const cooldownMs = options.select?.cooldownMs ?? 24 * 60 * 60_000;

  for (const match of fireable) {
    // Learned avoidance: a dismissed pattern never re-fires (stronger than the
    // time-bounded cooldown — the user said "stop suggesting this").
    if (isPatternDismissed(firedRecords, match.id)) {
      continue;
    }
    if (isPatternOnCooldown(firedRecords, match.id, now().getTime(), cooldownMs)) {
      continue;
    }
    try {
      // Composed (LLM) suggestion when a composer is supplied; else the
      // detector's verbatim text. Composition is fail-soft (undefined →
      // fallback) so a model glitch never drops the suggestion.
      let text = match.suggestion;
      if (options.composeSuggestion) {
        const composed = await options.composeSuggestion(match).catch(() => undefined);
        if (composed && composed.trim().length > 0) text = composed.trim();
      }
      await sendWithRetry(options.registry, options.providerId, {
        destination: options.destination,
        text
      });
      await recordPatternFired(options.patternsFiredFile, match.id, now().getTime());
      delivered += 1;
      fired.push(match);
      if (options.agentInitiatedNoticeBroker && options.agentInitiatedNoticeUserId) {
        try {
          options.agentInitiatedNoticeBroker.publish(options.agentInitiatedNoticeUserId, {
            generatedAt: now().toISOString(),
            kind: "pattern",
            sourceId: match.id,
            text
          });
        } catch (cause) {
          errors.push(`${match.id} broker: ${errorMessage(cause)}`);
        }
      }
    } catch (cause) {
      errors.push(`${match.id}: ${errorMessage(cause)}`);
    }
  }

  return { delivered, errors, fireable: fireable.length, fired };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
