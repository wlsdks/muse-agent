/**
 * Step 3b of `docs/design/episodic-memory.md` — wire the pure
 * pieces from step 3a (extractor + summariser) into the REPL exit
 * lifecycle. On graceful shutdown the REPL calls
 * `captureEndOfSessionEpisode`, which:
 *
 *   1. reads `~/.muse/last-chat.jsonl` (user/assistant turns) +
 *      `readSessionBoundaries()` (the markers step 2 wrote at boot)
 *   2. uses `extractCurrentSessionTurns` to find the range that
 *      belongs to the just-finished session
 *   3. asks `summariseSession` for a `{ summary, topics }` payload
 *   4. on success, `upsertEpisode` writes the episode into
 *      `~/.muse/episodes.json` and `vacuumEpisodes` keeps the file
 *      under the cap (default 500 entries; see store).
 *
 * Off by default — the design doc requires explicit opt-in via
 * `MUSE_EPISODIC_MEMORY_ENABLED=true`. Fail-soft at every step:
 * a missing model, an empty session, a transient generate error,
 * or an I/O glitch all yield `{ status: "skipped", reason: … }`
 * with no half-formed episode written.
 *
 * Tests in `apps/cli/test/program.test.ts` exercise the orchestrator
 * directly with a stub modelProvider and a temp HOME so neither the
 * model nor the real `~/.muse/*` paths are touched.
 */

import { randomUUID } from "node:crypto";

import {
  extractCurrentSessionTurns,
  summariseSession,
  type SessionBoundaryRef,
  type SessionTurnLine,
  type SummariseSessionOptions
} from "@muse/agent-core";
import {
  upsertEpisode,
  vacuumEpisodes,
  type PersistedEpisode
} from "@muse/mcp";
import { parseBoolean, resolveEpisodesFile } from "@muse/autoconfigure";
import { redactSecretsInText } from "@muse/shared";

// Pull the ModelProvider shape from the summariser's own options so
// @muse/cli stays off a direct @muse/model dependency — the
// orchestrator only needs whatever the summariser needs.
type ModelProviderLike = SummariseSessionOptions["modelProvider"];

import {
  readLastChatHistory,
  readSessionBoundaries
} from "./chat-history.js";

export interface CaptureEndOfSessionOptions {
  readonly modelProvider: ModelProviderLike;
  readonly model: string;
  /**
   * Default userId to record on the episode when the boundary line
   * itself didn't carry one (older history, or future surfaces that
   * skip the userId field). The REPL passes the active user.
   */
  readonly userId?: string;
  /**
   * Minimum number of turn lines (user + assistant counted separately)
   * before summarisation runs. Default 2 — anything below that is too
   * thin to be a useful episode.
   */
  readonly minTurnLines?: number;
  /** Override the episodes-file path (env: `MUSE_EPISODES_FILE`). */
  readonly episodesFile?: string;
  /** Max entries kept in `episodes.json`. Forwarded to `vacuumEpisodes`. */
  readonly maxEntries?: number;
  /** Injectable clock; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Test seam — defaults to `() => process.env`. */
  readonly readEnv?: () => NodeJS.ProcessEnv;
  /** Test seams for the history readers; defaults route through `chat-history.ts`. */
  readonly readLines?: () => Promise<readonly SessionTurnLine[]>;
  readonly readBoundaries?: () => Promise<readonly SessionBoundaryRef[]>;
}

export type CaptureResult =
  | { readonly status: "captured"; readonly episode: PersistedEpisode; readonly dropped: number }
  | { readonly status: "skipped"; readonly reason: string };

const DEFAULT_MIN_TURN_LINES = 2;

export async function captureEndOfSessionEpisode(options: CaptureEndOfSessionOptions): Promise<CaptureResult> {
  const readEnv = options.readEnv ?? (() => process.env);
  const env = readEnv();
  if (!parseBoolean(env.MUSE_EPISODIC_MEMORY_ENABLED, false)) {
    return {
      reason: "MUSE_EPISODIC_MEMORY_ENABLED is not enabled (set to true/1/yes/on to opt in)",
      status: "skipped"
    };
  }

  const readLines = options.readLines ?? readLastChatHistory;
  const readBoundaries = options.readBoundaries ?? readSessionBoundaries;
  const now = options.now ?? (() => new Date());
  const minTurnLines = Math.max(1, Math.trunc(options.minTurnLines ?? DEFAULT_MIN_TURN_LINES));

  let lines: readonly SessionTurnLine[];
  let boundaries: readonly SessionBoundaryRef[];
  try {
    [lines, boundaries] = await Promise.all([readLines(), readBoundaries()]);
  } catch (cause) {
    return { reason: `history read failed: ${errorMessage(cause)}`, status: "skipped" };
  }

  const range = extractCurrentSessionTurns(lines, boundaries);
  if (!range) {
    return { reason: "no current-session range (no boundary or no turns yet)", status: "skipped" };
  }
  if (range.turns.length < minTurnLines) {
    return {
      reason: `current session has ${range.turns.length.toString()} turn line(s), below threshold ${minTurnLines.toString()}`,
      status: "skipped"
    };
  }

  const summary = await summariseSession({
    model: options.model,
    modelProvider: options.modelProvider,
    turns: range.turns
  });
  if (!summary) {
    return { reason: "summariser returned undefined (model error or empty output)", status: "skipped" };
  }

  const episodesFile = options.episodesFile ?? resolveEpisodesFile(env as Record<string, string | undefined>);
  const ownerId = range.userId ?? options.userId;
  if (!ownerId) {
    return { reason: "no userId available (boundary missing it, no fallback supplied)", status: "skipped" };
  }
  // Re-scrub: the model can hallucinate a credential-shaped
  // string into the summary/topics even though input turns were
  // already redacted.
  const scrubbedTopics = summary.topics.map((topic) => redactSecretsInText(topic));
  const episode: PersistedEpisode = {
    endedAt: now().toISOString(),
    id: `ep_${randomUUID()}`,
    startedAt: range.startedAt,
    summary: redactSecretsInText(summary.summary),
    ...(scrubbedTopics.length > 0 ? { topics: scrubbedTopics } : {}),
    ...(summary.importance !== undefined ? { importance: summary.importance } : {}),
    userId: ownerId
  };

  try {
    await upsertEpisode(episodesFile, episode);
    const dropped = await vacuumEpisodes(episodesFile, options.maxEntries);
    return { dropped, episode, status: "captured" };
  } catch (cause) {
    return { reason: `persist failed: ${errorMessage(cause)}`, status: "skipped" };
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
