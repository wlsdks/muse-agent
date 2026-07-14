/**
 * Production summarizer: turns a Muse `ModelProvider` into a
 * `DroppedContextSummarizer` the runtime can inject. It runs the SAME
 * local model the agent already uses (a second cheap call) over the
 * compacted-away turns to produce a short recap.
 *
 * Model-AGNOSTIC: it takes the Muse `ModelProvider` abstraction, never a
 * vendor SDK, so wiring it keeps agent-core vendor-neutral. A genuine
 * provider failure still PROPAGATES (the fail-open contract lives in
 * `summarizeDroppedContext` in @muse/memory — a throw there becomes the
 * deterministic fallback) so a transient aux failure degrades to the
 * deterministic summary, never crashes the turn.
 *
 * Cooldown / ineffectiveness skip: without this, a persistently-failing
 * aux model (down, malformed response, timeout) re-attempts the LLM call on
 * EVERY subsequent compaction — the "CLI freeze" bug class. Only once a
 * failing call has exhausted its bounded retries (see below) does a cooldown
 * window open; while it's open the returned summarizer skips the LLM call
 * entirely and returns "" (which `summarizeDroppedContext` already treats
 * as "no aux summary" and falls back to the deterministic one) instead of
 * re-attempting. The same cooldown gate also opens after 2 consecutive
 * calls that each saved less than `ineffectivenessThreshold` of the
 * transcript length — paying for a model call that isn't helping is as
 * wasteful as paying for one that's failing. The gate is a plain cooldown,
 * not a permanent kill switch: once it expires, the next compaction tries
 * again, and an effective result resets the ineffectiveness streak.
 *
 * Retry-before-cooldown (DS-18): opening a 10-minute cooldown on the VERY
 * FIRST failure treats a transient blip (one dropped connection, one slow
 * response) the same as a real outage. Before the cooldown gate can open,
 * the `provider.generate` call gets `maxAttempts` bounded attempts with
 * exponential backoff between them — mirrors hermes'
 * `agent/auxiliary_client.py` (3 total attempts) for its identical
 * pinned-model aux-call mechanism. Only once ALL attempts are exhausted
 * does the cooldown open; a non-retryable error class (auth, bad request,
 * model-not-found — see `@muse/resilience`'s `classifyError`) still fails
 * fast on the first attempt, same as any other permanent failure.
 */

import { retry, RetryExhaustedError } from "@muse/resilience";

import type { DroppedContextSummarizer } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import { sleep as sharedSleep } from "@muse/shared";

const SUMMARIZER_SYSTEM_PROMPT =
  "You compress dropped conversation turns into a short factual recap that preserves names, decisions, and open questions. Output ONLY the recap — no preamble, no headings — in 2 to 4 sentences." +
  " Preserve any opaque identifier — a UUID, file path, URL, or number — VERBATIM; never paraphrase or drop it.";

// hermes' `/compact <focus>` pattern, adapted: when the caller names a
// topic (e.g. a chat `/compact <topic>` request), ask for full fidelity on
// that topic specifically while everything else still gets the terse
// treatment — rather than compressing the whole window uniformly.
function focusDirective(focusTopic: string): string {
  return ` Preserve FULL detail about anything related to "${focusTopic}" — do not compress or drop it; everything else can stay terse.`;
}

const DEFAULT_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_INEFFECTIVENESS_THRESHOLD = 0.1;
const DEFAULT_INEFFECTIVENESS_STREAK_LIMIT = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 4_000;
const RETRY_MULTIPLIER = 2;

export interface DroppedContextSummarizerOptions {
  /** Injectable clock for deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * How long a failing (or ineffective-streak-tripping) aux call keeps
   * skipping subsequent attempts. Defaults to 10 minutes, matching the
   * reference summarizer-failure cooldown this adapts.
   */
  readonly cooldownMs?: number;
  /**
   * Minimum fraction of the raw transcript length an aux summary must save
   * to count as "effective". A call that saves less counts toward the
   * ineffectiveness streak. Defaults to 0.10 (10%).
   */
  readonly ineffectivenessThreshold?: number;
  /**
   * Number of consecutive ineffective calls that opens the cooldown gate.
   * Defaults to 2.
   */
  readonly ineffectivenessStreakLimit?: number;
  /**
   * Total attempts (including the first) the aux call gets before the
   * failure cooldown opens. Defaults to 3 (2 retries), matching hermes'
   * `auxiliary_client.py` reference. A non-retryable error class (auth,
   * bad request, model-not-found) still fails on its first attempt.
   */
  readonly maxAttempts?: number;
  /**
   * Base delay for the exponential backoff between retry attempts
   * (delay = retryInitialDelayMs * 2^(attempt-1), capped at
   * `retryMaxDelayMs`). Defaults to 250ms.
   */
  readonly retryInitialDelayMs?: number;
  /** Hard cap on a single backoff delay. Defaults to 4000ms. */
  readonly retryMaxDelayMs?: number;
  /**
   * Injectable sleep for the backoff delays, so tests never take real
   * wall-clock time. Defaults to a real `setTimeout`-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createModelDroppedContextSummarizer(
  provider: ModelProvider,
  model: string,
  options: DroppedContextSummarizerOptions = {}
): DroppedContextSummarizer {
  const now = options.now ?? (() => new Date());
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const ineffectivenessThreshold = options.ineffectivenessThreshold ?? DEFAULT_INEFFECTIVENESS_THRESHOLD;
  const ineffectivenessStreakLimit = options.ineffectivenessStreakLimit ?? DEFAULT_INEFFECTIVENESS_STREAK_LIMIT;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryInitialDelayMs = options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const sleep = options.sleep ?? sharedSleep;

  let cooldownUntilMs = 0;
  let ineffectiveStreak = 0;

  return async (messages, callOptions) => {
    if (now().getTime() < cooldownUntilMs) {
      return "";
    }

    const transcript = messages
      .map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : ""}`)
      .join("\n");
    const focusTopic = callOptions?.focusTopic?.trim();
    const systemPrompt = focusTopic ? `${SUMMARIZER_SYSTEM_PROMPT}${focusDirective(focusTopic)}` : SUMMARIZER_SYSTEM_PROMPT;

    let response;
    try {
      response = await retry(
        () =>
          provider.generate({
            messages: [
              { content: systemPrompt, role: "system" },
              { content: transcript, role: "user" }
            ],
            model,
            temperature: 0.2
          }),
        {
          initialDelayMs: retryInitialDelayMs,
          maxAttempts,
          maxDelayMs: retryMaxDelayMs,
          multiplier: RETRY_MULTIPLIER,
          name: "dropped-context-summarizer",
          sleep
        }
      );
    } catch (error) {
      cooldownUntilMs = now().getTime() + cooldownMs;
      throw error instanceof RetryExhaustedError ? error.cause : error;
    }

    const savedRatio = transcript.length > 0 ? 1 - response.output.length / transcript.length : 1;
    if (savedRatio < ineffectivenessThreshold) {
      ineffectiveStreak += 1;
      if (ineffectiveStreak >= ineffectivenessStreakLimit) {
        cooldownUntilMs = now().getTime() + cooldownMs;
      }
    } else {
      ineffectiveStreak = 0;
    }

    return response.output;
  };
}
