/**
 * Privacy-tiered routing policy. Muse is local-first for privacy: a request
 * that carries ANY personal payload must never ride a cloud request. This is
 * a fail-close SECURITY classification — deterministic code, never a model
 * judgment — so "unsure" always resolves to `"personal"` / `"local"`.
 */

import { parseBooleanFromEnv } from "@muse/shared";

export type PrivacyClassification = "personal" | "context-free";

export interface PrivacyRequestInput {
  /**
   * True when the caller is about to attach ANY personal payload to the
   * request — notes chunks, memory facts, persona, personal-store sections,
   * or conversation history that contains user data. This alone is
   * decisive: it wins over every text signal below.
   *
   * Note on persona specifically: a persona preamble is a fixed, authored
   * string (not raw user data), yet it still counts as personal context here
   * — it reveals the user's chosen persona/relationship framing, so a turn
   * carrying it is kept local same as one carrying notes or memory facts.
   */
  readonly hasPersonalContext: boolean;
  readonly query: string;
  /**
   * Remembered fact values/keys (e.g. a contact name from memory). A query
   * that references one — asking about "Dr. Kim" by name — is personal even
   * with no possessive marker in the sentence.
   */
  readonly memoryValues?: readonly string[];
  /** Output of the existing PII input-guard detector (`findPii`). */
  readonly piiDetected?: boolean;
  /**
   * True when this request will invoke tools (calendar, memory, notes,
   * home, etc). Tools are conduits to personal data, so a tool-bearing
   * request is kept local regardless of how context-free its text reads —
   * the fail-close principle is "no personal-data conduit rides a cloud
   * request". Defense-in-depth: the chat surface also strips tools
   * structurally from its cloud turn (`buildCloudTurnRequest`), so this
   * signal codifies the same principle as a policy-layer guard for every
   * caller, not the only place it is enforced.
   */
  readonly usesTools?: boolean;
}

export interface PrivacyClassificationResult {
  readonly classification: PrivacyClassification;
  readonly reason: string;
}

// High-precision, word-bounded EN first-person/possessive markers. "me" and
// "my" are common enough that a bare substring match would false-positive
// constantly ("summary" contains "my"? no — but "gym", "army", "enemy" etc.
// do) — \b keeps this to the standalone word.
const EN_PERSONAL_MARKER_PATTERNS: readonly RegExp[] = [
  /\bmy\b/u,
  /\bmine\b/u,
  /\bmyself\b/u,
  /\bour\b/u,
  /\bours\b/u,
  /\bme\b/u
];

// Multi-character KO possessive/first-person tokens that are unambiguous as
// substrings — no common Korean word contains "내가", "나의", "저의", "제가",
// or "우리" as a false-positive prefix the way 내일 ("tomorrow")/내용
// ("content")/안내 ("notice") contain a bare "내".
// "내꺼"/"제꺼" are colloquial contracted forms of "내 거"/"제 거" ("my
// thing") — unambiguous as substrings because they use 꺼 (aspirated), not
// 거. Do NOT add 내거/제거 (unaspirated 거): 제거 means "removal/delete" and
// 내거 is not a standalone false-positive-free token in the same way — 거
// alone collides with real words (내일 "tomorrow", 안내 "notice", 내용
// "content" via 내; 제안 "proposal", 제품 "product" via 제) the way 꺼 never
// does.
const KO_PERSONAL_SUBSTRING_MARKERS: readonly string[] = ["내가", "나의", "저의", "제가", "우리", "내꺼", "제꺼"];

// The single-syllable KO pronouns 내/제 ("my"/"me") are NOT safe as bare
// substrings: 내일 (tomorrow), 내용 (content), 안내 (notice/guide), 제안
// (proposal), 제품 (product), 제목 (title) all contain them mid-word. Since
// JS \b is defined over [A-Za-z0-9_] and never fires between two Hangul
// characters, we can't reuse \b here — instead require 내/제 to be its own
// token: preceded by start-of-string or whitespace/punctuation, and followed
// by whitespace/punctuation or end-of-string (covers "내 일정", "제 이름은").
const KO_STANDALONE_PRONOUN = /(?:^|[\s,.!?~])[내제](?=[\s,.!?~]|$)/u;

/**
 * True when `memoryValues` contains a remembered fact that appears in
 * `query`. Trims and requires length ≥ 2 so single-character values (which
 * would match almost anything) can't fire.
 */
function matchedMemoryValue(query: string, memoryValues: readonly string[] | undefined): string | undefined {
  if (!memoryValues || memoryValues.length === 0) {
    return undefined;
  }
  const normalizedQuery = query.toLowerCase();
  for (const raw of memoryValues) {
    const value = raw.trim();
    if (value.length < 2) {
      continue;
    }
    if (normalizedQuery.includes(value.toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

/** The first EN/KO personal marker found in `query`, or undefined. */
function matchedQueryMarker(query: string): string | undefined {
  const normalized = query.toLowerCase();
  for (const pattern of EN_PERSONAL_MARKER_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      return match[0];
    }
  }
  if (KO_STANDALONE_PRONOUN.test(normalized)) {
    return "내/제";
  }
  for (const marker of KO_PERSONAL_SUBSTRING_MARKERS) {
    if (normalized.includes(marker)) {
      return marker;
    }
  }
  return undefined;
}

/**
 * Classify a request and name the signal that decided it — the reason
 * string is surfaced to the user ("Muse shows its work"). Checked in
 * descending order of certainty: caller-declared personal context, then
 * declared tool usage (same tier — a declared capability, not a text guess),
 * then PII, then a remembered-fact reference, then a text marker. Unsure (no
 * signal fires) resolves to `"context-free"` only because every prior check
 * failed to find a reason to keep it local — the fail-close default lives
 * in `resolvePrivacyRoutedModel`, not here.
 */
export function explainRequestPrivacy(input: PrivacyRequestInput): PrivacyClassificationResult {
  if (input.hasPersonalContext) {
    return {
      classification: "personal",
      reason: "request carries personal context (notes, memory, persona, or conversation history)"
    };
  }
  if (input.usesTools) {
    return {
      classification: "personal",
      reason: "request may invoke tools that read personal data (calendar, memory, notes, home) — kept local"
    };
  }
  if (input.piiDetected) {
    return { classification: "personal", reason: "query contains detected PII" };
  }
  const memoryHit = matchedMemoryValue(input.query, input.memoryValues);
  if (memoryHit) {
    return { classification: "personal", reason: `query references a remembered fact ("${memoryHit}")` };
  }
  const marker = matchedQueryMarker(input.query);
  if (marker) {
    return { classification: "personal", reason: `query contains a first-person/possessive marker ("${marker}")` };
  }
  return { classification: "context-free", reason: "no personal-context, PII, memory, or possessive signal detected" };
}

export function classifyRequestPrivacy(input: PrivacyRequestInput): PrivacyClassification {
  return explainRequestPrivacy(input).classification;
}

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  return parseBooleanFromEnv(value, fallback);
}

export interface PrivacyRoutedModelArgs {
  readonly query: string;
  readonly hasPersonalContext: boolean;
  readonly memoryValues?: readonly string[];
  readonly piiDetected?: boolean;
  /** See `PrivacyRequestInput.usesTools` — tool-bearing requests stay local. */
  readonly usesTools?: boolean;
  readonly defaultModel: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface PrivacyRoutedModelResult {
  readonly model: string;
  readonly route: "local" | "cloud";
  readonly reason: string;
}

/**
 * Route a request to a local or cloud model under the privacy-tiered
 * policy. Off by default — byte-identical to today (always local) until the
 * caller opts in with `MUSE_PRIVACY_ROUTING` + `MUSE_CLOUD_MODEL`.
 * `MUSE_LOCAL_ONLY` wins over everything: this check runs first and
 * unconditionally, so no downstream branch can ever route to cloud while it
 * is set (defense in depth — the model-router gate in `@muse/model` would
 * also refuse to construct the cloud provider, but this policy layer never
 * even attempts it).
 */
export function resolvePrivacyRoutedModel(args: PrivacyRoutedModelArgs): PrivacyRoutedModelResult {
  const localOnly = parseEnvBoolean(args.env.MUSE_LOCAL_ONLY, false);
  if (localOnly) {
    return {
      model: args.defaultModel,
      reason: "MUSE_LOCAL_ONLY is set; privacy routing never sends a request to the cloud",
      route: "local"
    };
  }

  const routingEnabled = parseEnvBoolean(args.env.MUSE_PRIVACY_ROUTING, false);
  if (!routingEnabled) {
    return { model: args.defaultModel, reason: "privacy routing is off (MUSE_PRIVACY_ROUTING not set)", route: "local" };
  }

  const cloudModel = args.env.MUSE_CLOUD_MODEL?.trim();
  if (!cloudModel) {
    return {
      model: args.defaultModel,
      reason: "privacy routing is on but MUSE_CLOUD_MODEL is not configured",
      route: "local"
    };
  }

  const { classification, reason } = explainRequestPrivacy({
    hasPersonalContext: args.hasPersonalContext,
    memoryValues: args.memoryValues,
    piiDetected: args.piiDetected,
    query: args.query,
    usesTools: args.usesTools
  });

  if (classification === "context-free") {
    return { model: cloudModel, reason: `context-free request routed to cloud (${reason})`, route: "cloud" };
  }

  return { model: args.defaultModel, reason: `personal request kept local: ${reason}`, route: "local" };
}
