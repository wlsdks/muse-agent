/**
 * Deterministic guard against pet-name KEY-BINDING fabrication.
 *
 * Production incident (2026-06, dogfood): one user turn about a DOG named
 * 보리 produced facts binding the same name to dog_name, cat_name,
 * pet_dog_name, pet_cat_name AND a pet_names list containing the literal
 * species word "고양이" — the value was genuinely user-stated (so the
 * provenance gate kept it), but the model invented the KEY bindings. The
 * existing chain (model-asserted-value → backstop → ephemeral) checks
 * values, never bindings; this module closes that gap in deterministic
 * code, drop-not-guess throughout. Display-side grouping keeps a wrong
 * binding visible; THIS guard stops new ones from being written.
 */

import { normalizeMemoryKey } from "./memory-user-store.js";

/** Variant keys the extractor emits for the same binding, canonicalized so
 * one entity stops sprawling across spellings. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  pet_cat_name: "cat_name",
  pet_dog_name: "dog_name"
};

/** The one-name-one-species family. `pet_names` participates in value
 * conflict checks but is species-neutral (it never wins a species dispute). */
const SPECIES_KEYS: ReadonlySet<string> = new Set(["cat_name", "dog_name"]);
const FAMILY_KEYS: ReadonlySet<string> = new Set(["cat_name", "dog_name", "pet_name", "pet_names"]);

const DOG_EVIDENCE = /강아지|멍멍이|puppy|\bdog\b|(?<![가-힣])개(?![가-힣])/iu;
const CAT_EVIDENCE = /고양이|냥이|야옹이|kitten|\bcat\b/iu;

/** Bare species words are not names — "고양이" as a pet's NAME is the
 * fabrication artifact this list exists for. (A real pet literally named
 * a species word is a documented, accepted false-drop.) */
const SPECIES_WORDS: ReadonlySet<string> = new Set([
  "강아지", "개", "멍멍이", "고양이", "냥이", "야옹이",
  "dog", "puppy", "cat", "kitten"
]);

function canonicalKey(key: string): string {
  const normalized = normalizeMemoryKey(key);
  return KEY_ALIASES[normalized] ?? normalized;
}

function normalizeValue(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function stripSpeciesTokens(value: string): string {
  return value
    .split(/[,·/]|\s+및\s+|\s+and\s+/iu)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !SPECIES_WORDS.has(token.toLowerCase()))
    .join(", ");
}

function speciesEvidenceKey(userTurn: string): string | undefined {
  const dog = DOG_EVIDENCE.test(userTurn);
  const cat = CAT_EVIDENCE.test(userTurn);
  if (dog && !cat) return "dog_name";
  if (cat && !dog) return "cat_name";
  // both or neither ⇒ no single-species evidence — drop-not-guess.
  return undefined;
}

/**
 * Batch-local half of the guard (needs the user's turn, not the store):
 * 1. canonicalize alias keys (a canonical key already in the batch wins);
 * 2. strip bare species words from family VALUES (drop the entry if empty);
 * 3. when one value lands under BOTH species keys in the same batch, keep
 *    only the binding the user's own words support; ambiguous ⇒ drop both.
 * Non-family keys pass through untouched. Pure.
 */
export function resolvePetBindingCandidates(
  facts: Readonly<Record<string, string>>,
  userTurn: string
): Record<string, string> {
  const canonical: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts)) {
    const target = canonicalKey(key);
    if (target in canonical && canonical[target] !== value) {
      // alias vs canonical disagreement — keep the first (canonical iterates
      // in batch order), never guess between two values.
      continue;
    }
    canonical[target] = value;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(canonical)) {
    if (!FAMILY_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    const stripped = stripSpeciesTokens(value);
    if (stripped.length === 0) {
      continue;
    }
    out[key] = stripped;
  }

  const dogValue = out["dog_name"] !== undefined ? normalizeValue(out["dog_name"]) : undefined;
  const catValue = out["cat_name"] !== undefined ? normalizeValue(out["cat_name"]) : undefined;
  if (dogValue !== undefined && dogValue === catValue) {
    const keep = speciesEvidenceKey(userTurn);
    for (const key of SPECIES_KEYS) {
      if (key !== keep) {
        delete out[key];
      }
    }
  }
  return out;
}

/**
 * Store-aware half: a candidate binding whose value already lives under a
 * DIFFERENT key of the family in the EXISTING facts is dropped — the first
 * binding wins until the user explicitly corrects it (remember/forget), so
 * a later extraction can't quietly rebind 보리 from dog to cat. Pure.
 */
export function dropExistingPetBindingConflicts(
  facts: Readonly<Record<string, string>>,
  existingFacts: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  if (!existingFacts) {
    return { ...facts };
  }
  const existingByValue = new Map<string, string>();
  for (const [key, value] of Object.entries(existingFacts)) {
    const canonical = canonicalKey(key);
    if (FAMILY_KEYS.has(canonical)) {
      existingByValue.set(normalizeValue(value), canonical);
    }
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(facts)) {
    const canonical = canonicalKey(key);
    if (FAMILY_KEYS.has(canonical)) {
      const boundTo = existingByValue.get(normalizeValue(value));
      if (boundTo !== undefined && boundTo !== canonical) {
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}
