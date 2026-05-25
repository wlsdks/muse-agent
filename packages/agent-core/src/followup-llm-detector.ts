/**
 * Step 5 of `docs/design/agent-self-followup.md` — opt-in LLM
 * fallback for the followup detector.
 *
 * The rule-based detector (`extractFollowupPromises`) catches
 * canonical shapes: "in 30 min", "tomorrow morning", "2시간 뒤",
 * etc. What it misses by design:
 *
 *   - conditional intent ("once the build passes I'll let you know")
 *   - multi-part promises ("I'll check at 3pm and 6pm")
 *   - paraphrased / softer phrasings ("circle back this evening")
 *
 * The LLM call here closes that gap with a tight extraction prompt
 * producing a JSON array. Pure-ish (one network call), no I/O
 * beyond the model request, fail-soft: any error / parse-failure /
 * empty result returns `[]`, so the caller's capture path falls
 * back to whatever the rule detector found (which may itself be
 * empty — that's fine; missed promise > spurious commitment).
 *
 * Budget control lives in the *caller*. The autoconfigure wiring
 * checks the per-day budget sidecar and only invokes this
 * detector when under cap; this module focuses on detection
 * mechanics.
 */

import type {
  ModelMessage,
  ModelProvider,
  ModelRequest
} from "@muse/model";

import type { FollowupPromise } from "./followup-detector.js";
import { iterateJsonArrayCandidates } from "./json-array-scan.js";

export interface ExtractFollowupPromisesLlmOptions {
  readonly modelProvider: ModelProvider;
  readonly model: string;
  /** Anchor for relative phrases the LLM may emit ("in 30 min", etc.). Defaults to `new Date()`. */
  readonly now?: Date;
  /** Max output tokens. Default 220 — the prompt asks for a single short JSON array. */
  readonly maxOutputTokens?: number;
  /** Temperature. Default 0.0 — extraction, not creative writing. */
  readonly temperature?: number;
}

const SYSTEM_PROMPT =
  `You are an extraction-only assistant. Read the assistant turn the user
provides and return ANY time-bound follow-up promises that turn makes.

Output STRICT JSON: a single array of objects. Each object has:
  - "originalText": the substring (≤ 160 chars) that produced the promise
  - "scheduledForIso": resolved ISO-8601 timestamp (assume the anchor time
    given in the user message; "tomorrow" = anchor + 1 day at 09:00,
    "in N minutes" = anchor + N min, etc.)
  - "kind": one of "conditional", "multi-part", "soft-recap"

If the turn contains no time-bound promise, return [].
NEVER invent a promise the turn does not actually make.
NEVER include explanatory text. The output must be JSON only.

Negative examples (DO NOT extract these):
  - "I'll think about it" → no time, drop
  - "Let me check" → no time, drop
  - "as we discussed earlier" → past reference, drop`;

export const LLM_FOLLOWUP_PAST_TOLERANCE_MS = 5 * 60_000;
export const LLM_FOLLOWUP_FUTURE_HORIZON_MS = 365 * 86_400_000;

export async function extractFollowupPromisesLlm(
  text: string,
  options: ExtractFollowupPromisesLlmOptions
): Promise<readonly FollowupPromise[]> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const now = options.now ?? new Date();
  const userMessage = `Anchor time: ${now.toISOString()}\n\nTurn:\n${trimmed}`;

  const messages: readonly ModelMessage[] = [
    { content: SYSTEM_PROMPT, role: "system" },
    { content: userMessage, role: "user" }
  ];
  const request: ModelRequest = {
    maxOutputTokens: options.maxOutputTokens ?? 220,
    messages,
    model: options.model,
    temperature: options.temperature ?? 0
  };

  let output: string;
  try {
    const response = await options.modelProvider.generate(request);
    output = (response.output ?? "").trim();
  } catch {
    return [];
  }
  if (output.length === 0) {
    return [];
  }
  return parseLlmDetectorOutput(output, now);
}

interface RawLlmPromise {
  readonly originalText?: unknown;
  readonly scheduledForIso?: unknown;
  readonly kind?: unknown;
}

function parseLlmDetectorOutput(raw: string, now: Date): readonly FollowupPromise[] {
  // Walk every JSON-array candidate and return the first that yields at
  // least one valid promise, so prose brackets in the preamble (and `]`
  // inside a promise's text, which the old first-`[` scanner mis-closed on)
  // can't drop the real array.
  for (const candidate of iterateJsonArrayCandidates(raw)) {
    const promises = promisesFromArray(candidate.value, now);
    if (promises.length > 0) {
      return promises;
    }
  }
  return [];
}

function promisesFromArray(parsed: readonly unknown[], now: Date): readonly FollowupPromise[] {
  const nowMs = now.getTime();
  const minScheduledMs = nowMs - LLM_FOLLOWUP_PAST_TOLERANCE_MS;
  const maxScheduledMs = nowMs + LLM_FOLLOWUP_FUTURE_HORIZON_MS;
  const out: FollowupPromise[] = [];
  const seenMinutes = new Set<number>();
  for (const entry of parsed) {
    const candidate = entry as RawLlmPromise;
    if (typeof candidate.originalText !== "string" || typeof candidate.scheduledForIso !== "string") {
      continue;
    }
    const scheduledFor = new Date(candidate.scheduledForIso);
    const scheduledMs = scheduledFor.getTime();
    if (!Number.isFinite(scheduledMs)) {
      continue;
    }
    if (scheduledMs < minScheduledMs || scheduledMs > maxScheduledMs) {
      continue;
    }
    // Dedupe by minute, like the rule detector, so a model that
    // emits the same time twice doesn't double-fire.
    const minuteKey = Math.floor(scheduledMs / 60_000);
    if (seenMinutes.has(minuteKey)) continue;
    seenMinutes.add(minuteKey);
    out.push({
      confidence: "low", // The LLM is a soft pin; rule-detected high stays the gold standard.
      kind: normaliseLlmKind(candidate.kind),
      originalText: candidate.originalText.slice(0, 160),
      scheduledFor
    });
  }
  return out;
}

function normaliseLlmKind(raw: unknown): FollowupPromise["kind"] {
  // The LLM is asked for "conditional" / "multi-part" / "soft-recap"
  // — none of which match the rule-detector's kind enum. Fold them
  // all into "today-at" as the closest neighbour: a soft pin
  // resolved by the LLM is treated as a same-day at-a-time promise
  // by the firing daemon. The diagnostic distinction lives in the
  // capture-hook's `kind: "llm-fallback"` override applied by the
  // caller when it stamps the persisted record.
  if (raw === "conditional" || raw === "multi-part" || raw === "soft-recap") {
    return "today-at";
  }
  return "today-at";
}
