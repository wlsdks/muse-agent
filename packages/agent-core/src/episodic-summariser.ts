/**
 * Step 3 of `docs/design/episodic-memory.md` — the LLM-driven
 * session summariser.
 *
 * Two responsibilities, both pure-ish (no I/O):
 *
 *   - `extractCurrentSessionTurns(lines, boundaries)` — find the
 *     turn range that belongs to the just-finished session. The
 *     REPL writes a `[SESSION_BOUNDARY]` sentinel at boot (step 2);
 *     the current session is everything *after* the most recent
 *     boundary in `last-chat.jsonl`. Returns `undefined` when no
 *     boundary has been written yet (fresh install) or when there
 *     are no user/assistant turns to summarise.
 *
 *   - `summariseSession({ turns, modelProvider, model, ... })` —
 *     one-shot text-generation call producing the
 *     `{ summary, topics }` payload that gets upserted into
 *     `~/.muse/episodes.json`. Fails soft: returns `undefined`
 *     on transport / parsing / empty-output errors so a transient
 *     model glitch never leaves a half-formed episode behind.
 *
 * Secret scrubbing happens here, before the transcript leaves the
 * machine — via the canonical `@muse/shared` redactor so the input
 * sent to the model is scrubbed with the same credential families as
 * every other outbound surface, not a weaker local subset.
 *
 * REPL exit wiring (read files → extract → summarise → upsert →
 * vacuum) lives in the next iter; this file is intentionally
 * I/O-free so tests don't have to fake a filesystem.
 */

import type {
  ModelMessage,
  ModelProvider,
  ModelRequest
} from "@muse/model";
import { redactSecretsInText } from "@muse/shared";

import { lexicalTokens } from "./knowledge-recall.js";

export interface SessionTurnLine {
  readonly role: "user" | "assistant";
  readonly content: string;
  /**
   * `true` when this ASSISTANT turn's answer rested on UNTRUSTED-only sources
   * (the source-check cue fired). Persisted per-turn so end-of-session episode
   * capture can mark the episode `trusted:false` even for turns from a PRIOR
   * process (a one-shot `muse chat` or a resumed session) the live REPL's
   * in-memory verdict never saw — the episode-laundering defense (MemoryGraft
   * arXiv:2512.16962). Absent ⇒ trusted/unknown.
   */
  readonly untrustedOnly?: boolean;
}

export interface SessionBoundaryRef {
  readonly tsIso: string;
  readonly userId?: string;
}

export interface CurrentSessionRange {
  readonly turns: readonly SessionTurnLine[];
  readonly startedAt: string;
  readonly userId?: string;
}

/**
 * Identify the turn range that belongs to the most-recent session
 * boundary. Boundaries arrive oldest-first (the order
 * `readSessionBoundaries` returns); the current session is
 * everything written after the last one.
 *
 * Argument shape is structural — the CLI reads
 * `last-chat.jsonl` itself and passes the parsed lines in. Keeping
 * the function I/O-free lets agent-core stay framework-independent.
 *
 * Returns `undefined` when:
 *   - no boundary has ever been written (fresh install), or
 *   - the current session has zero user/assistant turns (a REPL
 *     started + exited without any chat).
 */
export function extractCurrentSessionTurns(
  lines: readonly SessionTurnLine[],
  boundaries: readonly SessionBoundaryRef[]
): CurrentSessionRange | undefined {
  if (boundaries.length === 0) {
    return undefined;
  }
  const latest = boundaries[boundaries.length - 1]!;
  if (lines.length === 0) {
    return undefined;
  }
  return {
    startedAt: latest.tsIso,
    turns: lines,
    ...(latest.userId ? { userId: latest.userId } : {})
  };
}

/**
 * Scrub credential shapes from a transcript before it is sent to the
 * summariser model. Delegates to the canonical `@muse/shared`
 * redactor — a single source of truth covering private keys,
 * connection URIs, AWS / Google / Slack / Stripe / GitLab keys, JWTs,
 * and Telegram / Discord / Google-OAuth tokens. The prior local
 * implementation here only matched three prefixes, so a pasted DB URI
 * or bot token reached the model unredacted; this closes that gap.
 */
export function redactSecrets(text: string): string {
  return redactSecretsInText(text);
}

/** Default share of the summary's content tokens that must appear in the
 *  transcript for it to count as grounded. Deliberately LENIENT: a faithful
 *  paraphrase adds framing words ("decided"/"discussed") absent from the
 *  transcript, so its coverage sits well below 1 — the floor only needs to be
 *  high enough to reject a WHOLESALE fabrication (a summary about a topic the
 *  session never raised, which scores ~0), and low enough never to drop a real
 *  but terse summary. Dropping a faithful memory is worse than keeping a borderline
 *  one (the recall gate still applies downstream), so it errs lenient. */
export const DEFAULT_EPISODE_GROUNDING_FLOOR = 0.25;

/**
 * Is the model-written session `summary` actually grounded in the `turns` it
 * claims to summarise? The summariser asks the local model for "what the user
 * decided" + follow-ups — free text that is then PERSISTED as a citable
 * `[session: …]` source the recall gate trusts as ground truth. So this is the
 * fabrication check for the one INGEST surface of the edge: it measures the
 * fraction of the summary's content tokens (`lexicalTokens`, the same tokeniser
 * the recall gate uses) that occur anywhere in the transcript turns, and returns
 * false when that falls below `floor` — i.e. the summary talks about things the
 * session never did. Pure; an empty summary asserts nothing (true); an empty
 * transcript can ground nothing (false). The caller DROPS an ungrounded summary
 * rather than persist a hallucinated memory.
 */
export function summaryGroundedInTranscript(
  summary: string,
  turns: readonly SessionTurnLine[],
  floor: number = DEFAULT_EPISODE_GROUNDING_FLOOR
): boolean {
  const summaryTokens = lexicalTokens(summary);
  if (summaryTokens.size === 0) {
    return true;
  }
  const transcript = new Set<string>();
  for (const turn of turns) {
    for (const token of lexicalTokens(turn.content)) {
      transcript.add(token);
    }
  }
  if (transcript.size === 0) {
    return false;
  }
  let covered = 0;
  for (const token of summaryTokens) {
    if (transcript.has(token)) {
      covered += 1;
    }
  }
  return covered / summaryTokens.size >= floor;
}

export interface SessionSummary {
  readonly summary: string;
  readonly topics: readonly string[];
  /**
   * Write-time importance (1–10, Generative-Agents style). Omitted when
   * the model emits no parseable `importance:` line — recall then applies
   * no importance boost for this episode.
   */
  readonly importance?: number;
}

/** Minimum distinct content tokens for a summary to be worth retaining. */
export const DEFAULT_EPISODE_MIN_CONTENT_TOKENS = 5;
/** Self-rated importance at/below which the model deems the session trivial. */
export const DEFAULT_EPISODE_TRIVIAL_IMPORTANCE = 1;

/**
 * Episode-write SALIENCE admission gate (SSGM, arXiv:2603.11768 — govern what is
 * consolidated into long-term memory BEFORE the write, so low-value contexts
 * aren't "solidified into long-term storage" and don't dilute recall). The model
 * already self-rates `importance` (1–10), but today that number ONLY modulates
 * fade half-life downstream — it is NEVER an admission threshold, so an idle
 * greeting session is still persisted as a citable `[session: …]` source.
 *
 * Drop an episode ONLY when BOTH signals agree it's trivial: the summary is
 * content-THIN (< `minContentTokens` distinct content tokens, via the same
 * CJK-aware `lexicalTokens` the grounding gate uses — same-distribution lexical,
 * the cumulative lesson's allowed case) AND the model self-rated it at/below the
 * trivial floor. Requiring BOTH means a terse-but-IMPORTANT episode (high
 * importance, or no importance emitted) is always retained, and importance alone
 * never drops anything (an 8B is an unreliable self-verifier — the deterministic
 * thinness must corroborate). Fail-OPEN: a rich summary, or one with no
 * importance, is retained (today's behaviour). SUBTRACTIVE — it only declines to
 * store, never fabricates a memory. Pure + exported for direct coverage.
 */
export function isEpisodeWorthRetaining(
  summary: SessionSummary,
  options: { readonly minContentTokens?: number; readonly trivialImportanceAtOrBelow?: number } = {}
): boolean {
  const minTokens = Math.max(1, Math.trunc(options.minContentTokens ?? DEFAULT_EPISODE_MIN_CONTENT_TOKENS));
  const trivialAt = options.trivialImportanceAtOrBelow ?? DEFAULT_EPISODE_TRIVIAL_IMPORTANCE;
  const contentTokens = lexicalTokens(summary.summary).size;
  const thin = contentTokens < minTokens;
  const selfRatedTrivial = summary.importance !== undefined && summary.importance <= trivialAt;
  return !(thin && selfRatedTrivial);
}

/** Token-Jaccard at/above which a new episode summary is a near-duplicate of a stored one. */
export const DEFAULT_EPISODE_NOVELTY_MAX_OVERLAP = 0.8;
/** How many of the most-recent stored summaries the novelty gate compares against. */
export const DEFAULT_EPISODE_NOVELTY_RECENT = 10;

/**
 * Write-time NOVELTY gate (Mem0 write-side NOOP, arXiv:2504.19413; SAGE novelty
 * gate, arXiv:2605.30711): admit an episode only when it adds NEW information vs
 * the recently-stored ones. The other write gates (outcome-quality, grounding,
 * salience) judge an episode in ISOLATION, so a recurring topic re-summarised
 * near-identically passes them all and is persisted as yet another near-duplicate
 * `[session: …]` source that dilutes recall (the read-time `consolidateNearDuplicates`
 * only cleans up AFTER the write). Returns false (reject) when the summary's token
 * Jaccard ≥ `maxOverlap` against ANY of the `recent` most-recent stored summaries.
 * Deterministic + embedder-free (same CJK-aware `lexicalTokens` the other gates
 * use). Fail-OPEN: no recents / an empty summary → novel (never lose a session).
 * SUBTRACTIVE — only declines to store. Pure + exported for direct coverage.
 */
export function isEpisodeNovelVsRecent(
  summary: string,
  recentSummaries: readonly string[],
  options: { readonly maxOverlap?: number; readonly recent?: number } = {}
): boolean {
  const maxOverlap = Number.isFinite(options.maxOverlap) ? options.maxOverlap! : DEFAULT_EPISODE_NOVELTY_MAX_OVERLAP;
  const recentN = Math.max(1, Math.trunc(options.recent ?? DEFAULT_EPISODE_NOVELTY_RECENT));
  const a = lexicalTokens(summary);
  if (a.size === 0) return true;
  for (const text of recentSummaries.slice(0, recentN)) {
    const b = lexicalTokens(text);
    if (b.size === 0) continue;
    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection += 1;
    }
    const jaccard = intersection / (a.size + b.size - intersection);
    if (jaccard >= maxOverlap) return false;
  }
  return true;
}

export interface SummariseSessionOptions {
  readonly turns: readonly SessionTurnLine[];
  readonly modelProvider: ModelProvider;
  readonly model: string;
  /** Override the default scrubber (e.g. add corp-specific patterns). */
  readonly redact?: (text: string) => string;
  /** Max output tokens for the summariser call. Default 220. */
  readonly maxOutputTokens?: number;
  /** Temperature. Default 0.3 — favour faithful recap over creativity. */
  readonly temperature?: number;
}

const SUMMARISER_SYSTEM_PROMPT =
  `You are an end-of-session memory writer for Muse, the user's
JARVIS-style assistant. Summarise the following user↔assistant
chat as a single paragraph of at most 60 words. Capture, in this
order:
  1. WHAT subject was discussed (one short noun phrase).
  2. WHAT the user decided or where the matter stands.
  3. ANY explicit follow-up the user asked for.

Drop pleasantries, greetings, meta-chatter about the assistant
itself. Redact any secrets, tokens, or API keys that survived
the upstream scrubber. After the paragraph, on a NEW LINE, emit
"topics: " followed by 1–3 short noun-phrase tags separated by
commas (e.g. "topics: Q3 budget memo, Notion drafting"). Then, on a
NEW LINE, emit "importance: N" where N is an integer 1–10 rating how
important this session is to remember long-term: 10 = a pivotal
decision, commitment, or fact worth recalling for months; 1 = idle
small talk. No emojis, no markdown, no JSON.`;

/**
 * Run the summariser. Returns `undefined` on any failure — model
 * unreachable, empty output, missing summary section — so the
 * caller can skip persisting rather than write a partial entry.
 */
export async function summariseSession(options: SummariseSessionOptions): Promise<SessionSummary | undefined> {
  if (options.turns.length === 0) {
    return undefined;
  }
  const redact = options.redact ?? redactSecrets;
  const transcript = options.turns
    .map((turn) => `${turn.role}: ${redact(turn.content)}`)
    .join("\n");

  const messages: readonly ModelMessage[] = [
    { content: SUMMARISER_SYSTEM_PROMPT, role: "system" },
    { content: transcript, role: "user" }
  ];

  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 220,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0.3
  };

  let output: string;
  try {
    const response = await options.modelProvider.generate(request);
    output = (response.output ?? "").trim();
  } catch {
    return undefined;
  }
  if (output.length === 0) {
    return undefined;
  }
  return parseSummariserOutput(output);
}

function parseSummariserOutput(raw: string): SessionSummary | undefined {
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  // The `topics:` line is the last one when present; everything else
  // is the summary body. The model occasionally indents or omits the
  // section — we keep going either way.
  // LAST `topics:` line is the boundary (reverse scan rather
  // than findLastIndex to avoid bumping the TS lib target).
  let topicsIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^topics:\s*/iu.test(lines[i]!)) {
      topicsIndex = i;
      break;
    }
  }
  let body: readonly string[];
  let topics: readonly string[] = [];
  if (topicsIndex >= 0) {
    body = lines.slice(0, topicsIndex);
    const topicsRaw = lines[topicsIndex]!.replace(/^topics:\s*/iu, "");
    topics = topicsRaw
      .split(",")
      .map((topic) => topic.trim())
      .filter((topic) => topic.length > 0);
  } else {
    body = lines;
  }
  // The `importance:` line (model emits it after `topics:`) is parsed
  // independently and dropped from the summary body wherever it lands.
  const importanceLineRe = /^importance:\s*/iu;
  let importance: number | undefined;
  let importanceIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (importanceLineRe.test(lines[i]!)) {
      importanceIndex = i;
      const parsed = Number.parseInt(lines[i]!.replace(importanceLineRe, "").trim(), 10);
      if (Number.isFinite(parsed)) {
        importance = Math.min(10, Math.max(1, parsed));
      }
      break;
    }
  }
  if (importanceIndex >= 0) {
    body = body.filter((_, idx) => idx !== importanceIndex);
  }
  const summary = body.join(" ").trim();
  if (summary.length === 0) {
    return undefined;
  }
  return importance === undefined ? { summary, topics } : { summary, topics, importance };
}
