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
 * machine — the regex matches the patterns the design doc's
 * failure-modes section calls out (`sk-`, `gh[pso]_`, `ya29.`).
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

export interface SessionTurnLine {
  readonly role: "user" | "assistant";
  readonly content: string;
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

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk-|gh[pso]_|ya29\.)[A-Za-z0-9_./-]{6,}\b/gu,
  // Anthropic + Google API key shapes commonly leaked in chat.
  /\bsk-ant-[A-Za-z0-9_-]{6,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu
];

const SECRET_PLACEHOLDER = "<redacted-secret>";

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, SECRET_PLACEHOLDER);
  }
  return out;
}

export interface SessionSummary {
  readonly summary: string;
  readonly topics: readonly string[];
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
commas (e.g. "topics: Q3 budget memo, Notion drafting"). No
emojis, no markdown, no JSON.`;

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
  const summary = body.join(" ").trim();
  if (summary.length === 0) {
    return undefined;
  }
  return { summary, topics };
}
