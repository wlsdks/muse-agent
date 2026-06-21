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
  classifyEpisodeAdmissionQuality,
  extractCurrentSessionTurns,
  isEpisodeNovelVsRecent,
  isEpisodeWorthRetaining,
  peakEndDigest,
  summariseSession,
  summaryGroundedInTranscript,
  type SessionBoundaryRef,
  type SessionTurnLine,
  type SummariseSessionOptions
} from "@muse/agent-core";
import {
  readEpisodes,
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
  /**
   * `true` when ANY turn this session produced an answer that rested on
   * UNTRUSTED-only sources (the REPL accumulates `finalizeGatedChatAnswer`'s
   * `untrustedOnly` per turn). Marks the stored episode `trusted:false` so a later
   * recall can't launder the session's tool/feed-grounded content as trusted "your
   * own history" (MemoryGraft arXiv:2512.16962). Absent/false ⇒ trusted episode.
   */
  readonly untrustedSession?: boolean;
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

  // Outcome-quality write-admission (selective addition, arXiv:2505.16067): an
  // error-prone session (user corrected the assistant more than they approved)
  // must not become a stored episode — agents experience-follow, so its botched
  // outcome would later replay as cited [session: …] context. The correction's
  // LESSON is separately distilled to the playbook, so nothing learned is lost.
  const admission = classifyEpisodeAdmissionQuality(range.turns);
  if (!admission.admit) {
    return {
      reason: `error-prone session (${admission.corrections.toString()} correction(s) > ${admission.approvals.toString()} approval(s)) — episode not admitted to avoid experience-following error propagation`,
      status: "skipped"
    };
  }

  let summary = await summariseSession({
    model: options.model,
    modelProvider: options.modelProvider,
    turns: range.turns
  });
  // Peak-end fallback (C3; Kahneman 1993): when the LLM summariser is unavailable
  // or errors, don't LOSE the session — capture a deterministic two-point digest
  // (its peak + closing turns) instead. It quotes the transcript verbatim, so it
  // is grounded by construction and skips the grounding gate below.
  let groundedByConstruction = false;
  if (!summary) {
    const digest = peakEndDigest(range.turns);
    if (!digest) {
      return { reason: "summariser returned undefined and no peak-end digest possible", status: "skipped" };
    }
    summary = { summary: digest, topics: [] };
    groundedByConstruction = true;
  }

  // Grounding gate for the one INGEST surface of the edge: the summary is
  // model-written free text ("what the user decided", follow-ups) that becomes a
  // citable [session: …] source the recall gate trusts. DROP it — never persist —
  // when it isn't grounded in the transcript it claims to summarise, so a
  // hallucinated decision can't later be served back as a cited fact.
  if (!groundedByConstruction && !summaryGroundedInTranscript(summary.summary, range.turns)) {
    return {
      reason: "summary not grounded in the session transcript — dropped to avoid persisting a fabricated memory",
      status: "skipped"
    };
  }

  // Salience admission gate (SSGM arXiv:2603.11768): don't persist a content-thin
  // session the model itself rated trivial — it would only dilute recall as a
  // near-contentless citable [session: …] source. Subtractive + fail-open.
  if (!isEpisodeWorthRetaining(summary)) {
    return {
      reason: "session too low-salience to retain (content-thin and self-rated trivial)",
      status: "skipped"
    };
  }

  const episodesFile = options.episodesFile ?? resolveEpisodesFile(env as Record<string, string | undefined>);
  const ownerId = range.userId ?? options.userId;
  if (!ownerId) {
    return { reason: "no userId available (boundary missing it, no fallback supplied)", status: "skipped" };
  }
  // Write-time NOVELTY gate (Mem0 write-side NOOP arXiv:2504.19413; SAGE novelty
  // gate arXiv:2605.30711): the other gates judge this session in ISOLATION, so a
  // recurring topic re-summarised near-identically passes them all and is stored
  // as another near-duplicate [session: …] source that dilutes recall. Drop it
  // when it isn't novel vs the recently-stored episodes. Fail-OPEN on a read
  // error (never lose a session over a transient read failure).
  try {
    const recentSummaries = (await readEpisodes(episodesFile, env as NodeJS.ProcessEnv))
      .filter((e) => e.userId === ownerId)
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .map((e) => e.summary);
    if (!isEpisodeNovelVsRecent(summary.summary, recentSummaries)) {
      return {
        reason: "near-duplicate of a recently-stored episode — not persisted (write-time novelty gate)",
        status: "skipped"
      };
    }
  } catch {
    // fail-open: a transient read error must not lose the session
  }

  // Re-scrub: the model can hallucinate a credential-shaped
  // string into the summary/topics even though input turns were
  // already redacted.
  const scrubbedTopics = summary.topics.map((topic) => redactSecretsInText(topic));
  // The session's source-trust verdict: the live REPL's in-memory flag
  // (options.untrustedSession) OR any PERSISTED assistant turn in range marked
  // untrustedOnly — the latter covers turns from a PRIOR process (a one-shot
  // `muse chat` or a resumed session) the live REPL never saw (EP-1b). Either way
  // the episode is marked trusted:false so it can't later launder that content as
  // trusted "your own history" grounding (MemoryGraft arXiv:2512.16962).
  const sessionRestedOnUntrusted = options.untrustedSession === true
    || range.turns.some((turn) => turn.role === "assistant" && turn.untrustedOnly === true);
  const episode: PersistedEpisode = {
    endedAt: now().toISOString(),
    id: `ep_${randomUUID()}`,
    startedAt: range.startedAt,
    summary: redactSecretsInText(summary.summary),
    ...(scrubbedTopics.length > 0 ? { topics: scrubbedTopics } : {}),
    ...(summary.importance !== undefined ? { importance: summary.importance } : {}),
    // Only stored when false; absent ⇒ trusted.
    ...(sessionRestedOnUntrusted ? { trusted: false } : {}),
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
