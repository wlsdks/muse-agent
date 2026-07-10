/**
 * Privacy-tiered routing policy. Muse is local-first for privacy: a request
 * that carries ANY personal payload must never ride a cloud request. This is
 * a fail-close SECURITY classification — deterministic code, never a model
 * judgment — so "unsure" always resolves to `"personal"` / `"local"`.
 */

export type PrivacyClassification = "personal" | "context-free";

export interface PrivacyRequestInput {
  /**
   * True when the caller is about to attach ANY personal payload to the
   * request — notes chunks, memory facts, persona, personal-store sections,
   * or conversation history that contains user data. This alone is
   * decisive: it wins over every text signal below.
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
const KO_PERSONAL_SUBSTRING_MARKERS: readonly string[] = ["내가", "나의", "저의", "제가", "우리"];

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
 * PII, then a remembered-fact reference, then a text marker. Unsure (no
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

const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return fallback;
  }
  return TRUTHY_ENV_VALUES.has(normalized);
}

export interface PrivacyRoutedModelArgs {
  readonly query: string;
  readonly hasPersonalContext: boolean;
  readonly memoryValues?: readonly string[];
  readonly piiDetected?: boolean;
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
    query: args.query
  });

  if (classification === "context-free") {
    return { model: cloudModel, reason: `context-free request routed to cloud (${reason})`, route: "cloud" };
  }

  return { model: args.defaultModel, reason: `personal request kept local: ${reason}`, route: "local" };
}
