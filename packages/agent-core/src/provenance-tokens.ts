import { normalizeForRecall } from "./recall-lexical.js";

// Content tokens of a value/utterance: lowercased runs of letters/digits/Hangul,
// >= 2 chars (a 1-char token is too common to ground on). normalizeForRecall FIRST
// (NFC + full-width fold) so text in NFC grounds against text typed/pasted NFD
// (macOS) — without it a real value is falsely treated as having no overlap.
// Shared by tool-argument-grounding (anti-fabrication) and the taint gate
// (actuator-provenance-gate) so both reason about identical tokenization.
export function contentTokens(text: string): string[] {
  return (normalizeForRecall(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}

export function contentTokenSet(text: string): Set<string> {
  return new Set(contentTokens(text));
}
