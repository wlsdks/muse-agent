/**
 * Pure data layer for the user's contacts (`~/.muse/contacts.json`)
 * plus the name→identifier resolver.
 *
 * P13: a JARVIS knows who people are. Equally, this is the
 * recipient-resolution backbone for outbound safety
 * (`.claude/rules/outbound-safety.md` rule 3: "Recipient is resolved,
 * never guessed"): `resolveContact` returns `ambiguous` / `unknown`
 * rather than picking a best guess, so the caller asks a clarifying
 * question instead of mailing the wrong person.
 *
 * Same durability posture as the other personal stores: atomic
 * fsync+rename write, tolerant read, corrupt store quarantined aside.
 * Read-only resolution needs no approval gate.
 */

import type { JsonObject } from "@muse/shared";

import { withFileMutationQueue } from "./atomic-file-store.js";
import { decryptFileAtRest, encryptFileAtRest, isFileEncryptedAtRest, readMaybeEncrypted, withFileLock, writeMaybeEncrypted } from "./encrypted-file.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly handle?: string;
  /** Phone number as the user typed it, e.g. `+1 415 555 0101` — stored verbatim, not reformatted. */
  readonly phone?: string;
  readonly aliases?: readonly string[];
  /** Birthday as `MM-DD` or `YYYY-MM-DD`. Year (if given) is ignored for the recurring reminder. */
  readonly birthday?: string;
  /**
   * How this person relates to the user — a free-text role, e.g. "manager",
   * "wife", "doctor", "landlord". Powers "who is my manager?" recall (the
   * relationship-graph foundation); NOT an identifier, so it never resolves a
   * recipient (that stays name / phone / email / handle).
   */
  readonly relationship?: string;
  /**
   * Edges to OTHER people in the graph — "who works with whom". Each is the
   * linked person's `name` plus an optional symmetric relation label
   * ("works with", "friends with"). Powers "who works with Bob?" recall: the
   * query names a person → that contact's block lists their connections.
   * Recorded bidirectionally by `linkContacts`. NOT an identifier (never
   * resolves a recipient).
   */
  readonly connections?: readonly { readonly to: string; readonly as?: string }[];
  /**
   * Free-text facts the user wants Muse to remember about this person —
   * "allergic to nuts", "likes hiking", "met at PyCon 2024". NOT an
   * identifier and NOT a relationship role; it is recall material, surfaced
   * as grounding evidence so "what do I know about Bob?" / "what is Bob
   * allergic to?" answers from it with the contact as the cited source.
   */
  readonly about?: string;
}

export interface UpcomingBirthday {
  readonly contact: Contact;
  /** Normalised `MM-DD`. */
  readonly date: string;
  readonly daysUntil: number;
}

function parseBirthdayMonthDay(raw: string | undefined): { month: number; day: number } | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const match = /^(?:\d{4}-)?(\d{2})-(\d{2})$/u.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  return { day, month };
}

/**
 * Upcoming birthdays within `withinDays` (default 30), soonest first.
 * The next occurrence is computed from `now` with a year-wrap (a date
 * already past this year rolls to next year); a contact with no /
 * malformed `birthday` is skipped.
 */
const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function resolveUpcomingBirthdays(
  contacts: readonly Contact[],
  options: { readonly now?: Date; readonly withinDays?: number } = {}
): UpcomingBirthday[] {
  const now = options.now ?? new Date();
  const withinDays = Number.isFinite(options.withinDays) ? Math.max(0, Math.trunc(options.withinDays as number)) : 30;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const pad = (n: number): string => String(n).padStart(2, "0");
  const out: UpcomingBirthday[] = [];
  for (const contact of contacts) {
    const md = parseBirthdayMonthDay(contact.birthday);
    if (!md) {
      continue;
    }
    // A 02-29 birthday has no real date in a common year: new Date(y, 1, 29)
    // silently rolls to Mar 1, which would phantom-surface the contact with the
    // impossible date "02-29". Clamp it to 02-28 (the common-year convention) so
    // the reported date is real and consistent with daysUntil.
    const occurrence = (year: number): { time: number; day: number } => {
      const day = md.month === 2 && md.day === 29 && !isLeapYear(year) ? 28 : md.day;
      return { time: new Date(year, md.month - 1, day).getTime(), day };
    };
    let occ = occurrence(today.getFullYear());
    if (occ.time < today.getTime()) {
      occ = occurrence(today.getFullYear() + 1);
    }
    const daysUntil = Math.round((occ.time - today.getTime()) / 86_400_000);
    if (daysUntil <= withinDays) {
      out.push({ contact, date: `${pad(md.month)}-${pad(occ.day)}`, daysUntil });
    }
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil || a.contact.name.localeCompare(b.contact.name));
}

/**
 * One-line briefing fragment for upcoming birthdays — "Sarah today;
 * Bob tomorrow; Ann in 3 days" — or `undefined` when there are none, so
 * the brief stays quiet rather than printing an empty line.
 */
export function formatBirthdayBriefLine(upcoming: readonly UpcomingBirthday[]): string | undefined {
  if (upcoming.length === 0) {
    return undefined;
  }
  return upcoming
    .map(({ contact, daysUntil }) => {
      const when = daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil.toString()} days`;
      return `${contact.name} ${when}`;
    })
    .join("; ");
}

export type ContactResolution =
  | { readonly status: "resolved"; readonly contact: Contact }
  | { readonly status: "ambiguous"; readonly matches: readonly Contact[] }
  | { readonly status: "unknown" };

export async function readContacts(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly Contact[]> {
  // A WRONG key THROWS here (fail-closed) — propagate it; an undecryptable people
  // graph is NOT corrupt and must NEVER be quarantined-to-empty (that would erase
  // the user's contacts on a key mismatch). The ask path reads contacts fail-soft,
  // and resolveContact fails CLOSED (a recipient never resolves on a bad key, so a
  // send refuses / clarifies — never a wrong send).
  const { text } = await readMaybeEncrypted(file, env);
  if (text === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { contacts?: unknown }).contacts)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { contacts: unknown[] }).contacts.flatMap((entry): readonly Contact[] => {
    const contact = coerceContact(entry);
    return contact ? [contact] : [];
  });
}

export async function writeContacts(file: string, contacts: readonly Contact[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const text = `${JSON.stringify({ contacts }, null, 2)}\n`;
  // Peek + write under the cross-process migration lock so an ordinary add can't
  // race `encryptContactsAtRest` and clobber it with a stale-format payload;
  // format is preserved (encrypted stays encrypted). atomicWriteFile keeps 0o600.
  await withFileLock(file, async () => {
    const encrypted = await isFileEncryptedAtRest(file);
    await writeMaybeEncrypted(file, text, encrypted, env);
  });
}

/** Add a contact. Idempotent on `id`: re-adding the same id REPLACES. */
export async function addContact(file: string, contact: Contact, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Serialise the read-modify-write: a lost contact is a recipient that later
  // won't resolve, which under outbound-safety rule 3 (recipient resolved, never
  // guessed) means a send is refused / a clarify fires instead of reaching the
  // intended person. Concurrent adds must not clobber.
  await withFileMutationQueue(file, async () => {
    const existing = await readContacts(file, env);
    const filtered = existing.filter((entry) => entry.id !== contact.id);
    await writeContacts(file, [...filtered, contact], env);
  });
}

export async function removeContact(file: string, id: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return withFileMutationQueue(file, async () => {
    const existing = await readContacts(file, env);
    const next = existing.filter((entry) => entry.id !== id);
    if (next.length === existing.length) {
      return false;
    }
    await writeContacts(file, next, env);
    return true;
  });
}

export async function queryContacts(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly Contact[]> {
  const all = await readContacts(file, env);
  return [...all].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Record a SYMMETRIC edge between two existing contacts (bidirectional, so recall
 * works from either side): adds `{to: B, as}` to A and `{to: A, as}` to B,
 * de-duplicated by target (an existing edge's label is updated). Names resolve
 * case-insensitively against name/aliases. Returns ok:false (no write) when a
 * name is unknown or both resolve to the same contact.
 */
export async function linkContacts(
  file: string,
  nameA: string,
  nameB: string,
  as?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly ok: boolean; readonly reason?: string }> {
  return withFileMutationQueue(file, async () => {
    const all = await readContacts(file, env);
    const a = findContactByName(all, nameA);
    const b = findContactByName(all, nameB);
    if (!a) return { ok: false, reason: `no contact named "${nameA}"` };
    if (!b) return { ok: false, reason: `no contact named "${nameB}"` };
    if (a.id === b.id) return { ok: false, reason: "a contact cannot be linked to itself" };
    const next = all.map((c) => {
      if (c.id === a.id) return { ...c, connections: upsertConnection(c.connections, b.name, as) };
      if (c.id === b.id) return { ...c, connections: upsertConnection(c.connections, a.name, as) };
      return c;
    });
    await writeContacts(file, next, env);
    return { ok: true };
  });
}

// Canonicalise a contact name/alias for matching: NFC + full-width-ASCII fold + lowercase
// (mirrors @muse/agent-core normalizeForRecall; INLINED because @muse/stores sits below
// @muse/agent-core and can't import it without a cycle). A KO contact stored NFD (macOS) must
// resolve against an NFC query — outbound recipient resolution (outbound-safety rule 3) must not
// report `unknown` for an EXISTING contact on a Unicode-form mismatch, sending the user into a
// dead-end clarify loop or, worse, a wrong recipient.
function normalizeName(name: string): string {
  return name.trim().normalize("NFC").replace(/[！-～]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toLowerCase();
}

function findContactByName(all: readonly Contact[], name: string): Contact | undefined {
  const q = normalizeName(name);
  if (q.length === 0) return undefined;
  return all.find((c) => normalizeName(c.name) === q || (c.aliases ?? []).some((alias) => normalizeName(alias) === q));
}

function upsertConnection(
  existing: readonly { readonly to: string; readonly as?: string }[] | undefined,
  to: string,
  as?: string
): readonly { readonly to: string; readonly as?: string }[] {
  const rest = (existing ?? []).filter((edge) => normalizeName(edge.to) !== normalizeName(to));
  return [...rest, { to, ...(as ? { as } : {}) }];
}

/**
 * Canonical empty body — seeded when encrypting an absent/empty store so the
 * encrypted format is ESTABLISHED on disk (else the first later add would peek
 * "no file", land in plaintext, and drop the encrypt intent).
 */
const EMPTY_CONTACTS_BODY = `${JSON.stringify({ contacts: [] }, null, 2)}\n`;

/**
 * One-shot migrate the people graph to encryption-at-rest (AES-256-GCM under the
 * shared MUSE_MEMORY_KEY / per-host fallback — the same envelope memory /
 * episodes / action-log use). Snapshots a plaintext backup BEFORE encrypting,
 * runs under the cross-process lock, idempotent.
 */
export async function encryptContactsAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyEncrypted: boolean; readonly backupPath?: string }> {
  return encryptFileAtRest(file, env, { emptyContent: EMPTY_CONTACTS_BODY });
}

/** Reverse the migration — rewrite the people graph as plaintext. Throws fail-closed on a wrong key. */
export async function decryptContactsAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyPlaintext: boolean }> {
  return decryptFileAtRest(file, env);
}

/** Format-only check (no key needed) — is the people graph encrypted at rest? */
export async function isContactsEncrypted(file: string): Promise<boolean> {
  return isFileEncryptedAtRest(file);
}

/**
 * Resolve a free-text name/alias to a single contact. Returns
 * `resolved` ONLY on a unique match; multiple matches are `ambiguous`
 * (the caller must clarify, never guess) and no match is `unknown`.
 *
 * An exact name/alias match wins; only when there is no exact match
 * does it fall back to a case-insensitive substring match — so "Bob"
 * resolves to the contact literally named "Bob" even when another
 * contact's name contains "bob" (e.g. "Bobby"), rather than reporting
 * a spurious ambiguity.
 */
export function resolveContact(contacts: readonly Contact[], query: string): ContactResolution {
  const q = normalizeName(query);
  if (q.length === 0) {
    return { status: "unknown" };
  }
  const exact = contacts.filter((contact) => matchesExact(contact, q));
  const pool = exact.length > 0 ? exact : contacts.filter((contact) => matchesPartial(contact, q));
  if (pool.length === 0) {
    return { status: "unknown" };
  }
  if (pool.length === 1) {
    return { contact: pool[0]!, status: "resolved" };
  }
  return { matches: pool, status: "ambiguous" };
}

export function contactIdentifier(contact: Contact): string | undefined {
  return contact.email ?? contact.handle;
}

export function serializeContact(contact: Contact): JsonObject {
  return {
    id: contact.id,
    name: contact.name,
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.handle ? { handle: contact.handle } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(contact.aliases && contact.aliases.length > 0 ? { aliases: [...contact.aliases] } : {}),
    ...(contact.birthday ? { birthday: contact.birthday } : {}),
    ...(contact.relationship ? { relationship: contact.relationship } : {}),
    ...(contact.connections && contact.connections.length > 0
      ? { connections: contact.connections.map((c) => ({ to: c.to, ...(c.as ? { as: c.as } : {}) })) }
      : {}),
    ...(contact.about ? { about: contact.about } : {})
  };
}

function stripLeadingAt(value: string): string {
  return value.replace(/^@/u, "");
}

/**
 * Match two phone numbers by their digits, tolerating format
 * differences ('+1 415-555-0101' vs '(415) 555-0101' vs '4155550101').
 * Requires ≥7 digits on both sides so a short / digit-light query can't
 * collide, and accepts a suffix match so a stored local number resolves
 * a query that carries a country-code prefix (and vice versa).
 */
function phoneMatches(a: string, b: string): boolean {
  const da = a.replace(/\D/gu, "");
  const db = b.replace(/\D/gu, "");
  if (da.length < 7 || db.length < 7) {
    return false;
  }
  const suffixMatch = (x: string, y: string): boolean => x === y || x.endsWith(y) || y.endsWith(x);
  // Also compare with a leading national-trunk prefix (a leading 0, DROPPED in the E.164
  // international form) normalised off: KR "010-1234-5678" is the same number as "+82 10-1234-5678",
  // but the trunk 0 sits where the country code would be, so a raw suffix compare misses it. A
  // contact synced in international format must still resolve from a domestic number, and vice versa.
  return suffixMatch(da, db) || suffixMatch(da.replace(/^0+/u, ""), db.replace(/^0+/u, ""));
}

function matchesExact(contact: Contact, q: string): boolean {
  return normalizeName(contact.name) === q
    || (contact.aliases?.some((alias) => normalizeName(alias) === q) ?? false)
    // A phone number is an unambiguous identifier too — "who is
    // +1 415-555-0101?" (an inbound caller / texter) must resolve the
    // contact, matched by digits so formatting differences don't miss.
    || (contact.phone !== undefined && phoneMatches(contact.phone, q))
    // A full email address / handle is an unambiguous identifier — "email
    // bob@acme.com" / "who is @bobby?" must resolve the matching contact,
    // not fall through to unknown. Handle compares with a leading "@"
    // stripped on both sides so "@bobby" and "bobby" are the same.
    || contact.email?.toLowerCase() === q
    || (contact.handle !== undefined && stripLeadingAt(contact.handle.toLowerCase()) === stripLeadingAt(q));
}

function matchesPartial(contact: Contact, q: string): boolean {
  return normalizeName(contact.name).includes(q)
    || (contact.aliases?.some((alias) => normalizeName(alias).includes(q)) ?? false);
}

/**
 * Read-boundary coercion for one raw store entry. `id` + `name` are
 * mandatory strings (a missing one drops the whole entry, same as
 * before). Every OPTIONAL field is kept ONLY when it is the declared
 * string type — a hand-edited / externally-synced `contacts.json` that
 * writes `phone: 14155550101` (a number) or a non-string email would
 * otherwise survive the tolerant read and later crash `resolveContact`
 * (`phoneMatches`/`stripLeadingAt` call string methods), taking down
 * resolution for EVERY contact, not just the malformed one. Dropping the
 * bad field (not the whole contact) keeps the most data while
 * guaranteeing the returned `Contact` matches its type.
 */
function coerceContact(value: unknown): Contact | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const c = value as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.name !== "string") {
    return undefined;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const aliases = Array.isArray(c.aliases)
    ? c.aliases.filter((a): a is string => typeof a === "string")
    : undefined;
  const email = str(c.email);
  const handle = str(c.handle);
  const phone = str(c.phone);
  const birthday = str(c.birthday);
  const relationship = str(c.relationship);
  const about = str(c.about);
  // Drop any malformed edge (missing/non-string `to`) rather than crash the read.
  const connections = Array.isArray(c.connections)
    ? c.connections.flatMap((e): readonly { to: string; as?: string }[] => {
        if (!e || typeof e !== "object") return [];
        const to = str((e as Record<string, unknown>).to);
        if (to === undefined) return [];
        const as = str((e as Record<string, unknown>).as);
        return [{ to, ...(as !== undefined ? { as } : {}) }];
      })
    : undefined;
  return {
    id: c.id,
    name: c.name,
    ...(email !== undefined ? { email } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(birthday !== undefined ? { birthday } : {}),
    ...(relationship !== undefined ? { relationship } : {}),
    ...(connections && connections.length > 0 ? { connections } : {}),
    ...(about !== undefined ? { about } : {})
  };
}
