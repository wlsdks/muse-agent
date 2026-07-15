import { normalizeForRecall } from "./recall-lexical.js";
import { contentTokens } from "./provenance-tokens.js";
import { isRecord } from "@muse/shared";

export interface ToolArgumentGrounding {
  /** A NEW arguments object with ungrounded designated args removed. */
  readonly args: Record<string, unknown>;
  /** Names of the args that were dropped as fabricated (not in the utterance). */
  readonly dropped: readonly string[];
}

/**
 * Deterministic anti-fabrication for tool ARGUMENTS. The local 8B fabricates
 * OPTIONAL free-text actuator annotations — a calendar `location` / `notes` the
 * user never mentioned ("회의 잡아줘" → location "강남역") — and they get
 * PERSISTED. A schema "omit if unspecified" instruction is ~0% effective on an
 * 8B, so the guarantee has to be CODE, not prompt (tool-calling.md). For each
 * arg a tool marks as `groundedArgs`, drop its value unless it is grounded in
 * the user's utterance.
 *
 * CONSERVATIVE on purpose (protect against false drops): a string value is kept
 * if ANY of its content tokens appears as a substring of the utterance — so a
 * value carried across Korean particle attachment ("강남역" grounded by
 * "강남역에서") survives, and only a value with NO overlap at all is dropped.
 * Empty values and an empty utterance are left untouched (fail-open: never drop
 * when grounding can't be assessed). A string-ARRAY arg (e.g. task `tags`) keeps
 * its grounded elements and drops only the fabricated ones; a partially-cleaned
 * array keeps the surviving elements and is NOT listed in `dropped` — `dropped`
 * contains only args whose value was removed entirely. Required args are the
 * caller's concern — pass only optional free-text arg names in `groundedArgs`.
 */
/**
 * Per-field grounding modes, selected with a `name:mode` entry in
 * `groundedArgs` (a bare name keeps the default ANY-token rule).
 *
 * IDENTIFIER-class fields invert the module's usual bias. The default rule
 * protects against false DROPS, but for an email/handle the failure that
 * matters is the false KEEP: the local part / handle body is usually the
 * contact's NAME — which IS in the utterance — so a fabricated
 * `bob@gmail.com` invented from "밥 저장해줘" grounds via the name token
 * and gets PERSISTED, later misdirecting an outbound send. For these
 * fields a wrong kept value is worse than a dropped real one (the clarify
 * path recovers a drop; nothing recovers a silently-saved wrong address):
 *
 * - `email`  — the DOMAIN must be grounded: every domain label except the
 *   TLD appears in the utterance (the local part cannot vouch). A value
 *   without `@` falls back to the default rule.
 * - `handle` — the utterance must literally contain `@<body>` (checked on
 *   the RAW utterance; normalisation strips `@`). A name alone can never
 *   vouch for a handle it did not state.
 * - `date`   — every numeric component must appear as a NUMBER in the
 *   utterance (zero-padding-insensitive, so `05-15` grounds on "5월 15일"),
 *   or as its English month name ("May 15" grounds `05-15`). Token matching
 *   is useless here because the model REFORMATS dates, which both
 *   false-drops honest values and lets stray digits vouch for wrong ones.
 * - `phone`  — the value's FULL digit run must appear in the utterance's own
 *   digits, separators ignored. Under the default rule any digit-sharing token
 *   vouches, so an invented `010-1234-5678` grounds on an unrelated "1234번
 *   회의실" in the same sentence — a fabricated number persisted onto a
 *   contact, with the same misdirected-outbound blast radius as an email.
 *   Separator-insensitivity keeps an honestly-stated number in a different
 *   format ("010 1234 5678" vs "010-1234-5678") grounded.
 */
type GroundingMode = "any" | "date" | "email" | "handle" | "phone";

const EN_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

function parseGroundedArg(entry: string): { readonly name: string; readonly mode: GroundingMode } {
  const idx = entry.indexOf(":");
  if (idx < 0) {
    return { mode: "any", name: entry };
  }
  const mode = entry.slice(idx + 1);
  const name = entry.slice(0, idx);
  return mode === "email" || mode === "handle" || mode === "date" || mode === "phone"
    ? { mode, name }
    : { mode: "any", name };
}

export function groundToolArguments(
  args: Record<string, unknown>,
  groundedArgs: readonly string[],
  utterance: string
): ToolArgumentGrounding {
  const haystack = normalizeForRecall(utterance).toLowerCase();
  const rawLower = utterance.toLowerCase();
  // The utterance's digit RUNS — each maximal digit sequence, plus the runs
  // rejoined across PHONE-INTERNAL separators only (space / hyphen / dot /
  // parens / +), so "010 1234 5678" is one candidate number while "회의실 1234번,
  // 내선 5678" stays two. A global concat of every digit in the utterance was the
  // bug: it manufactured "12345678" out of a room number and an extension, and
  // that vouched a wholly fabricated phone.
  const utteranceNumbers = (utterance.match(/\d[\d\s().+-]*\d|\d/gu) ?? [])
    .map((run) => run.replace(/\D/gu, ""))
    .filter((run) => run.length > 0);
  if (haystack.trim().length === 0 || groundedArgs.length === 0) {
    return { args, dropped: [] };
  }
  // Match a value token at a WORD START (preceded by start-of-string or a
  // non-letter/digit), not as a raw substring: a fabricated "art" is NOT grounded
  // by "start the meeting", while morphology ("meeting" prefixes "meetings") and
  // Korean particle attachment ("강남역" prefixes "강남역에서") still ground — both
  // are prefix matches. contentTokens yields [\p{L}\p{N}] runs only, so the token
  // carries no regex metacharacters and needs no escaping.
  const tokenGrounded = (token: string): boolean => new RegExp(`(^|[^\\p{L}\\p{N}])${token}`, "u").test(haystack);
  const anyTokenGrounded = (value: string): boolean => {
    const tokens = contentTokens(value);
    return tokens.length === 0 || tokens.some(tokenGrounded);
  };
  const numberGrounded = (numeric: string): boolean => {
    const bare = String(Number(numeric));
    if (bare === "NaN") {
      return false;
    }
    return new RegExp(`(^|[^0-9])0*${bare}([^0-9]|$)`, "u").test(rawLower);
  };
  const dateGrounded = (value: string): boolean => {
    const components = value.match(/\d+/gu) ?? [];
    if (components.length === 0) {
      return anyTokenGrounded(value);
    }
    return components.every((component) => {
      if (numberGrounded(component)) {
        return true;
      }
      const asMonth = Number(component);
      return asMonth >= 1 && asMonth <= 12 && rawLower.includes(EN_MONTHS[asMonth - 1] ?? "\u0000");
    });
  };
  const emailGrounded = (value: string): boolean => {
    const at = value.indexOf("@");
    if (at <= 0 || at === value.length - 1) {
      return anyTokenGrounded(value);
    }
    const labels = value.slice(at + 1).toLowerCase().split(".").filter((label) => label.length > 0);
    const vouching = labels.length > 1 ? labels.slice(0, -1) : labels;
    return vouching.length > 0 && vouching.every((label) => contentTokens(label).every(tokenGrounded));
  };
  const handleGrounded = (value: string): boolean => {
    const body = value.replace(/^@+/u, "").toLowerCase();
    return body.length === 0 || rawLower.includes(`@${body}`);
  };
  const phoneGrounded = (value: string): boolean => {
    const digits = value.replace(/\D/gu, "");
    if (digits.length === 0) {
      return anyTokenGrounded(value);
    }
    return utteranceNumbers.some((stated) => {
      if (stated === digits) {
        return true;
      }
      // The model normalises a stated number by ADDING a country/area prefix the
      // user did not type ("415-555-0101" → "+1 415 555 0101"). A prefix is
      // formatting; the digits the user actually typed are the number. So the
      // value must END WITH a number the user stated (and that stated number must
      // itself be phone-length, so an order id or a room number cannot vouch) —
      // never merely CONTAIN one, which would let a different area code
      // ("628-555-0101" against a stated "415-555-0101") pass as the same phone.
      // 9 digits, not 7: a shorter stated run is not a complete number, so it can
      // be an order id or a ticket number that merely happens to tail a
      // fabricated phone ("order 20250115" vouching "010-2025-0115").
      return stated.length >= 9 && digits.endsWith(stated);
    });
  };
  const isGroundedByMode = (value: string, mode: GroundingMode): boolean => {
    if (mode === "phone") return phoneGrounded(value);
    if (mode === "email") return emailGrounded(value);
    if (mode === "handle") return handleGrounded(value);
    if (mode === "date") return dateGrounded(value);
    return anyTokenGrounded(value);
  };
  const dropped: string[] = [];
  const next: Record<string, unknown> = { ...args };
  for (const entry of groundedArgs) {
    const { name, mode } = parseGroundedArg(entry);
    const isGrounded = (value: string): boolean => isGroundedByMode(value, mode);
    const value = next[name];
    if (typeof value === "string" && value.trim().length > 0) {
      if (!isGrounded(value)) {
        delete next[name];
        dropped.push(name);
      }
      continue;
    }
    // A string ARRAY (e.g. task `tags`) — drop the fabricated ELEMENTS, keep the
    // grounded ones; remove the arg entirely only if nothing survives.
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const kept = (value as string[]).filter((item) => item.trim().length === 0 || isGrounded(item));
      if (kept.length === 0 && value.length > 0) {
        // every element fabricated → the arg itself is dropped
        delete next[name];
        dropped.push(name);
      } else if (kept.length < value.length) {
        // partial: keep the grounded elements; the arg SURVIVES, so it is NOT
        // reported as "dropped" (dropped = args removed entirely, per the contract)
        next[name] = kept;
      }
      continue;
    }
    // A nested OBJECT (e.g. an actuator `meta` of free-text fields) — clean each
    // fabricated STRING leaf the same way, keeping grounded leaves and all
    // non-string leaves (numbers/booleans aren't free text to ground). Same
    // partial-vs-empty contract as the array branch: a partially-cleaned object
    // SURVIVES (not reported dropped); only an object emptied of all its keys is
    // removed entirely. So the fabrication gate is total over value shapes, not
    // string-only — a fabricated `meta.note` can no longer ride a nested object
    // past the gate and get persisted.
    if (isRecord(value)) {
      const obj = value;
      const cleaned: Record<string, unknown> = {};
      for (const [leafKey, leafValue] of Object.entries(obj)) {
        if (typeof leafValue === "string" && leafValue.trim().length > 0 && !isGrounded(leafValue)) {
          continue; // fabricated free-text leaf — drop it
        }
        cleaned[leafKey] = leafValue;
      }
      const keptCount = Object.keys(cleaned).length;
      const originalCount = Object.keys(obj).length;
      if (keptCount === 0 && originalCount > 0) {
        delete next[name];
        dropped.push(name);
      } else if (keptCount < originalCount) {
        next[name] = cleaned;
      }
    }
  }
  return { args: next, dropped };
}
