/**
 * Output-side citation enforcement + normalisation for the recall wedge — the
 * code-not-model half of "shows its work". `enforceAnswerCitations` is the gate:
 * it strips (or drops the whole sentence for) any citation whose target is NOT a
 * real source Muse showed the model, so a fabricated citation can never reach the
 * user BY CODE. The `normalize*Citations` helpers rewrite the local model's
 * natural-but-wrong citation forms (contact / memory / structured-class / slot)
 * to the canonical shape the gate accepts, BEFORE the gate runs, so a correctly
 * grounded answer isn't false-stripped for a formatting mismatch.
 */

import {
  type AllowedCitations,
  CITATION_RE,
  type CitationEnforcement
} from "./grounding-citations.js";
import { lexicalTokens, normalizeForRecall } from "./recall-lexical.js";

function resolvesExact(value: string, allowed: readonly string[]): boolean {
  // NFC both sides so a KO citation marker (e.g. a Hangul note title) resolves to its source
  // regardless of NFD/NFC origin — the sibling of the lexical tokeniser's normalisation.
  const v = normalizeForRecall(value).trim().toLowerCase();
  return allowed.some((item) => normalizeForRecall(item).trim().toLowerCase() === v);
}

const FILE_EXT_RE = /\.[a-z0-9]{1,8}$/iu;

function basenameOf(value: string): string {
  const parts = value.trim().split(/[/\\]/u);
  return parts[parts.length - 1] ?? value;
}

/** Fold away the noise a real identifier legitimately varies on — directory
 * prefix, file extension, hyphen/underscore-vs-space — down to a comparable
 * core form. `"notes/vpn-setup.md"`, `"vpn_setup.md"`, and `"vpn-setup"` all
 * fold to `"vpn setup"`. */
function canonicalFormOf(value: string): string {
  const base = normalizeForRecall(basenameOf(value)).trim().toLowerCase();
  return base.replace(FILE_EXT_RE, "").replace(/[-_]+/gu, " ").trim();
}

/**
 * Tolerant resolution for an EXACT-match class (notes/feeds/browsing — path /
 * name / hostname identifiers), tried only AFTER exact match already failed.
 * The local model routinely cites a real source by basename, without its
 * extension, with hyphens swapped for underscores or spaces, or paraphrased as
 * a human title ("VPN Setup Notes" for `vpn-setup.md`) — none of which
 * `resolvesExact` accepts, so treating them as fabrication would delete a
 * TRUE claim. Tries, in order: (1) the value's canonical form matches exactly
 * one candidate's canonical form (basename/extension/hyphen-insensitive); (2)
 * the CANDIDATE's own canonical-form tokens are ALL present in the citation's
 * tokens (the model may pad a title, but can't inflate an identifier's core
 * words from nothing). Returns the matched candidate VERBATIM (for the caller
 * to rewrite the citation to) when exactly one resolves either way.
 *
 * Fail-close on ambiguity: when 2+ candidates tie at either stage, this
 * returns `undefined` (unresolved) rather than guess between two real
 * sources — the same "don't guess the recipient" posture as contact
 * resolution. An unresolved citation still falls through to the fabrication
 * path below, so ambiguity is treated exactly like a genuine invention.
 */
function resolveTolerant(value: string, allowed: readonly string[]): string | undefined {
  const valueCanon = canonicalFormOf(value);
  if (valueCanon.length === 0) return undefined;
  const canonMatches = allowed.filter((item) => canonicalFormOf(item) === valueCanon);
  if (canonMatches.length === 1) return canonMatches[0];
  if (canonMatches.length > 1) return undefined;

  const valueTokens = lexicalTokens(value);
  if (valueTokens.size === 0) return undefined;
  const tokenMatches = allowed.filter((item) => {
    const itemTokens = lexicalTokens(canonicalFormOf(item));
    if (itemTokens.size === 0) return false;
    for (const token of itemTokens) {
      if (!valueTokens.has(token)) return false;
    }
    return true;
  });
  return tokenMatches.length === 1 ? tokenMatches[0] : undefined;
}

// Free-text citations (task/event/reminder titles): the model may PARAPHRASE
// the title, so an exact match would false-strip a real one. A citation
// resolves when it shares any CONTENT token with a real item of that type; a
// wholly-invented title (no overlap with anything the user has) is stripped.
function resolvesByOverlap(value: string, allowed: readonly string[]): boolean {
  const tokens = lexicalTokens(value);
  if (tokens.size === 0) {
    return false;
  }
  return allowed.some((item) => {
    const itemTokens = lexicalTokens(item);
    if (itemTokens.size === 0) {
      return false;
    }
    let shared = 0;
    for (const token of tokens) {
      if (itemTokens.has(token)) {
        shared += 1;
      }
    }
    // A SINGLE incidental shared token must not validate a citation: a
    // fabricated `[task: pay the attacker]` shares "pay" with a real "pay rent"
    // task and would otherwise be kept on an unrelated claim. Require ≥2 shared
    // tokens, OR — so a genuinely short title still resolves — that the shorter
    // side is a single token and it matches.
    return shared >= 2 || (Math.min(tokens.size, itemTokens.size) === 1 && shared >= 1);
  });
}

/**
 * Rewrite the local model's natural-but-wrong contact citations to the
 * canonical `[contact: <name>]` form the gate accepts — BEFORE
 * `enforceAnswerCitations` runs. A `<<contact N — id>>` wrapper is a structural
 * sibling of the `<<note N — file>>` wrapper the model cites as `[from file]`,
 * so qwen3:8b tends to cite a contact with the note verb or by slot/id —
 * `[from contact 1]`, `[from contact: mina]`, `[contact 1]` — which the
 * exact-match note gate then false-strips, firing a spurious "treat as
 * unverified" warning on a correctly-grounded answer about the user's OWN
 * address book. This maps every "contact"-anchored mis-form to
 * `[contact: <name>]` by code: an in-range slot number, or an id / name that
 * token-overlaps a real matched contact, resolves to that contact's name; an
 * unresolvable reference (`[from contact 9]`) is left untouched for the gate to
 * strip. Pure + deterministic; only touches a citation whose first token is
 * literally `contact`, so a real `[from contacts.md]` note citation is never
 * rewritten.
 */
export function normalizeContactCitations(
  answer: string,
  contacts: ReadonlyArray<{ readonly id: string; readonly name: string }>
): string {
  if (contacts.length === 0) {
    return answer;
  }
  const resolveName = (ref: string): string | undefined => {
    const trimmed = ref.trim();
    if (/^\d+$/u.test(trimmed)) {
      const slot = Number(trimmed);
      return slot >= 1 && slot <= contacts.length ? contacts[slot - 1]?.name : undefined;
    }
    const low = trimmed.toLowerCase();
    const exact = contacts.find((c) => c.id.toLowerCase() === low || c.name.toLowerCase() === low);
    if (exact) {
      return exact.name;
    }
    const refTokens = lexicalTokens(trimmed);
    if (refTokens.size === 0) {
      return undefined;
    }
    const overlap = contacts.find((c) => {
      const nameTokens = lexicalTokens(c.name);
      for (const token of refTokens) {
        if (nameTokens.has(token)) {
          return true;
        }
      }
      return false;
    });
    return overlap?.name;
  };
  const withContactVerb = answer.replace(
    /\[\s*(?:from\s+)?contact\s*(?:[:#-]\s*|\s+)([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => {
      const name = resolveName(ref);
      return name ? `[contact: ${name}]` : match;
    }
  );
  // Also catch the bare NOTE-verb form `[from <X>]` where <X> is the raw
  // `contact_<uuid>` id (or the full contact name) the model echoed — the
  // `contact`-anchored pass above misses it because the id is `contact_<uuid>`
  // (no "contact" + separator). Only an EXACT id / name match is rewritten
  // (separator- and case-insensitive, never a fuzzy token overlap), so a real
  // `[from note.md]` is never mistaken for a contact.
  const normRef = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  const exactContactName = (ref: string): string | undefined => {
    const low = ref.trim().toLowerCase();
    const n = normRef(ref);
    const hit = contacts.find((c) => c.id.toLowerCase() === low || normRef(c.id) === n || normRef(c.name) === n);
    return hit?.name;
  };
  return withContactVerb.replace(
    /\[from\s+([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => {
      const name = exactContactName(ref);
      return name ? `[contact: ${name}]` : match;
    }
  );
}

/**
 * Rewrite a remembered-fact cited with the NOTE verb to the canonical
 * `[memory: <key>]` form — the local model (especially in Korean, where the
 * `[memory: …]` hint block isn't injected because the query doesn't lexically
 * match the English fact key) tends to cite a fact it knows from the persona as
 * `[from car_license_plate]`, which the exact-match note gate then false-strips.
 * Only a `[from <X>]` whose `<X>` EXACTLY matches a known memory key (separator /
 * case-insensitive) is rewritten; a real `[from note.md]` is left untouched, so a
 * note citation is never mistaken for a memory.
 */
export function normalizeMemoryCitations(answer: string, memoryKeys: readonly string[]): string {
  if (memoryKeys.length === 0) {
    return answer;
  }
  const norm = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  const keys = new Set(memoryKeys.map(norm));
  return answer.replace(
    /\[from\s+([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => (keys.has(norm(ref)) ? `[memory: ${ref.trim()}]` : match)
  );
}

/**
 * Strip the redundant note-verb "from " the model sometimes prepends to a
 * STRUCTURED citation — `[from commit: …]`, `[from task: …]`, `[from event: …]` —
 * so it reads as the canonical `[commit: …]` / `[task: …]` the gate validates by
 * class. Without this, the note regex (`[from <X>]`) mis-catches it first and
 * false-strips a TRUE structured citation as a non-existent note. Only a KNOWN
 * class keyword + ":" is rewritten, so a real `[from note.md]` is never touched.
 */
export function normalizeFromPrefixedCitations(answer: string): string {
  return answer.replace(
    /\[from\s+(task|event|reminder|session|feed|browsing|contact|command|commit|memory|action)\s*:/giu,
    "[$1:"
  );
}

/**
 * Rewrite a STRUCTURED citation the model wrote by SLOT NUMBER — `[from session 1]`,
 * `[from event 2]` — into the canonical `[<class>: <that slot's content>]` the gate
 * validates by class. The grounding markers are slot-numbered (`<<session N — id>>`),
 * so a reasoning-off model often cites the slot rather than the title; without this
 * the note regex mis-catches `[from session 1]` and false-strips a TRUE recall.
 * `slotsByClass` maps each class to the ORDERED list shown to the model (slot N →
 * index N-1); an out-of-range slot is left untouched for the gate to judge.
 */
export function normalizeSlotCitations(
  answer: string,
  slotsByClass: Readonly<Record<string, readonly string[]>>
): string {
  return answer.replace(
    // `[from session 1]`, the bare `[feed 1]` (the model often drops "from" for the
    // slot-numbered markers `<<feed N — name>>`), or `[from session 1 — ep_001]`
    // when it echoes the marker whole — the optional "from " and trailing "— <id>"
    // are both ignored.
    /\[(?:from\s+)?(task|event|reminder|session|feed|browsing|contact|command|commit|memory|action)\s+(\d+)(?:\s*[—–-]\s*[^\]]*)?\s*\]/giu,
    (match: string, cls: string, num: string) => {
      const list = slotsByClass[cls.toLowerCase()];
      const content = list?.[Number.parseInt(num, 10) - 1];
      return content ? `[${cls.toLowerCase()}: ${content}]` : match;
    }
  );
}

/**
 * Output-side grounding gate for the recall WEDGE — the code-not-model half of
 * "shows its work". Strips ANY citation the answer makes — `[from <note>]`,
 * `[feed: <name>]`, `[task|event|reminder: <title>]` — whose target is NOT
 * among the real sources Muse actually showed the model, so a fabricated
 * citation to something the user doesn't have can never reach them BY CODE
 * (mirrors `parseReflections` / `parseCouncilAnswer`). Notes + feeds match
 * exactly (they are identifiers); the free-text title forms match on
 * content-token overlap so a paraphrased-but-real citation survives — including
 * `[session: …]`, matched against the retrieved past-session summaries.
 */
/**
 * The citation classes the gate validates, keyed by `AllowedCitations` field.
 * Every class DROPS the whole claim (sentence) when its citation neither
 * resolves NOR tolerantly resolves, and no other citation in the sentence is
 * valid — a fabricated CLAUSE must never survive the gate as a bare, uncited
 * assertion. The EXACT classes (notes/feeds/browsing — matched by
 * path/name/hostname) carry `tolerant` + `wrap`: `resolvesExact` only tolerates
 * case/NFC/full-width/whitespace variance, but the local model routinely cites
 * a real source by basename, without its extension, or paraphrased as a title
 * — `resolveTolerant` resolves THOSE (fail-closing only on a genuine ambiguous
 * tie between two real sources), and the citation is REWRITTEN to the
 * canonical form via `wrap` so the claim survives WITH an accurate citation
 * instead of either being falsely dropped or kept mis-cited. The free-text
 * OVERLAP classes already tolerate paraphrase by resolving on shared content
 * tokens and are kept verbatim (no canonical rewrite — there is no single
 * "canonical" phrasing for a task/event/reminder title).
 */
const CITATION_CLASSES: readonly {
  readonly re: RegExp;
  readonly key: keyof AllowedCitations;
  readonly resolves: (value: string, allowed: readonly string[]) => boolean;
  readonly tolerant?: (value: string, allowed: readonly string[]) => string | undefined;
  readonly wrap?: (canonical: string) => string;
}[] = [
  { key: "notes", re: CITATION_RE, resolves: resolvesExact, tolerant: resolveTolerant, wrap: (v) => `[from ${v}]` },
  { key: "feeds", re: /\[feed:\s*([^\]]+?)\s*\]/giu, resolves: resolvesExact, tolerant: resolveTolerant, wrap: (v) => `[feed: ${v}]` },
  { key: "browsing", re: /\[browsing:\s*([^\]]+?)\s*\]/giu, resolves: resolvesExact, tolerant: resolveTolerant, wrap: (v) => `[browsing: ${v}]` },
  { key: "tasks", re: /\[task:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "events", re: /\[event:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "reminders", re: /\[reminder:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "sessions", re: /\[session:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "contacts", re: /\[contact:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "commands", re: /\[command:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "commits", re: /\[commit:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "memories", re: /\[memory:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "actions", re: /\[action:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap },
  { key: "flows", re: /\[flow:\s*([^\]]+?)\s*\]/giu, resolves: resolvesByOverlap }
];

/**
 * Split `text` into sentences LOSSLESSLY (`split.join("") === text`): a boundary is
 * `.`/`!`/`?`/newline at bracket depth 0 (a `.` inside a `[from a.md]` citation is
 * NOT a boundary), extended over consecutive terminators + trailing inline whitespace
 * so the delimiter stays with its sentence and a rejoin is byte-exact.
 */
function splitCitationSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "[") { depth++; continue; }
    if (ch === "]") { if (depth > 0) depth--; continue; }
    if (depth === 0 && (ch === "." || ch === "!" || ch === "?" || ch === "\n")) {
      let j = i + 1;
      while (j < text.length && (text[j] === "." || text[j] === "!" || text[j] === "?")) j++;
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\n")) j++;
      out.push(text.slice(start, j));
      start = j;
      i = j - 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

type CitationClass = (typeof CITATION_CLASSES)[number];

/** Resolve one citation VALUE against `allowed` — exact first, then (when the
 * class supports it) the tolerant path. `canonical` is set only when the
 * tolerant path resolved (an exact hit is kept verbatim by the caller). */
function resolveCitation(
  c: CitationClass,
  value: string,
  allowed: readonly string[]
): { readonly valid: boolean; readonly canonical?: string } {
  if (c.resolves(value, allowed)) return { valid: true };
  const canonical = c.tolerant?.(value, allowed);
  return canonical !== undefined ? { valid: true, canonical } : { valid: false };
}

export function enforceAnswerCitations(answer: string, allowed: AllowedCitations): CitationEnforcement {
  const stripped: string[] = [];
  const kept: string[] = [];
  for (const sentence of splitCitationSentences(answer)) {
    let hasValid = false;
    let hasInvalid = false;
    for (const c of CITATION_CLASSES) {
      for (const m of sentence.matchAll(c.re)) {
        const value = m[1]!.trim();
        const allowedList = allowed[c.key] ?? [];
        if (resolveCitation(c, value, allowedList).valid) hasValid = true;
        else hasInvalid = true;
      }
    }
    // DROP a sentence grounded ONLY on a citation that fails to resolve (even
    // tolerantly) — an un-groundable claim removed by code, not laundered into
    // an un-cited assertion. A sentence with ANY valid citation is kept and
    // merely loses the bad marker below (a real source elsewhere rescues it).
    if (hasInvalid && !hasValid) {
      for (const c of CITATION_CLASSES) {
        for (const m of sentence.matchAll(c.re)) {
          if (!resolveCitation(c, m[1]!.trim(), allowed[c.key] ?? []).valid) stripped.push(m[1]!.trim());
        }
      }
      continue;
    }
    let s = sentence;
    for (const c of CITATION_CLASSES) {
      s = s.replace(c.re, (match: string, raw: string) => {
        const value = raw.trim();
        const { valid, canonical } = resolveCitation(c, value, allowed[c.key] ?? []);
        if (!valid) {
          stripped.push(value);
          return "";
        }
        // A TOLERANT hit (not exact) is rewritten to the canonical source so the
        // claim survives WITH an accurate citation, not a mis-formatted one.
        return canonical !== undefined && c.wrap ? c.wrap(canonical) : match;
      });
    }
    kept.push(s);
  }
  let text = kept.join("");
  // Only tidy whitespace when a citation was actually removed (the cleanup exists to
  // close the seam a stripped `[...]` / dropped sentence leaves). Running it on a CLEAN
  // answer collapses multi-space runs and mangles code-block indentation / aligned
  // columns — so leave an un-stripped answer byte-for-byte verbatim.
  if (stripped.length > 0) {
    text = text
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+([.,;!?])/gu, "$1")
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/[ \t]+$/u, ""); // a DROPPED trailing sentence leaves the prior one's trailing space
  }
  return { stripped, text };
}

/**
 * The fixed hedge shown when {@link enforceAnswerCitations} drops EVERY sentence
 * of an answer as un-groundable — an empty string reads as a silent bug, not an
 * honest abstention. Deliberately opens with "I'm not sure" so it is itself a
 * `REFUSAL_MARKERS` hit (`@muse/recall/text.ts`): downstream refusal detection
 * (citation stripping, the "Removed N citation(s)" warning suppression, run-log
 * outcome labelling) classifies it exactly like any other honest refusal.
 */
export const UNGROUNDABLE_ANSWER_NOTICE = "I'm not sure — none of that checks out against a real source.";

/**
 * Apply the weak-framing fallback for a caller that shows the gate's result
 * directly to the user: when stripping fabricated citations gutted the WHOLE
 * answer, surface the fixed hedge instead of a blank response. A no-op when
 * anything survived, or when nothing was stripped in the first place.
 *
 * NEVER call this from the live streaming filter (`createCitationStreamFilter`'s
 * `clean` callback) — that gate runs per isolated `[…]` SPAN, not per sentence,
 * so an empty result there is the correct "drop this span" outcome, not a gutted
 * answer; substituting the hedge mid-stream would inject prose into running text.
 */
export function withUngroundableFallback(enforced: CitationEnforcement): string {
  return enforced.stripped.length > 0 && enforced.text.trim().length === 0
    ? UNGROUNDABLE_ANSWER_NOTICE
    : enforced.text;
}
