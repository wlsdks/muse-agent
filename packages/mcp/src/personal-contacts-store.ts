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

import { promises as fs } from "node:fs";

import type { JsonObject } from "@muse/shared";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

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
    let next = new Date(today.getFullYear(), md.month - 1, md.day);
    if (next.getTime() < today.getTime()) {
      next = new Date(today.getFullYear() + 1, md.month - 1, md.day);
    }
    const daysUntil = Math.round((next.getTime() - today.getTime()) / 86_400_000);
    if (daysUntil <= withinDays) {
      out.push({ contact, date: `${pad(md.month)}-${pad(md.day)}`, daysUntil });
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

async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readContacts(file: string): Promise<readonly Contact[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
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

export async function writeContacts(file: string, contacts: readonly Contact[]): Promise<void> {
  // Atomic, fsync'd, owner-only write via the shared primitive (randomUUID tmp →
  // no same-ms rename-collision crash).
  await atomicWriteFile(file, `${JSON.stringify({ contacts }, null, 2)}\n`);
}

/** Add a contact. Idempotent on `id`: re-adding the same id REPLACES. */
export async function addContact(file: string, contact: Contact): Promise<void> {
  // Serialise the read-modify-write: a lost contact is a recipient that later
  // won't resolve, which under outbound-safety rule 3 (recipient resolved, never
  // guessed) means a send is refused / a clarify fires instead of reaching the
  // intended person. Concurrent adds must not clobber.
  await withFileMutationQueue(file, async () => {
    const existing = await readContacts(file);
    const filtered = existing.filter((entry) => entry.id !== contact.id);
    await writeContacts(file, [...filtered, contact]);
  });
}

export async function removeContact(file: string, id: string): Promise<boolean> {
  return withFileMutationQueue(file, async () => {
    const existing = await readContacts(file);
    const next = existing.filter((entry) => entry.id !== id);
    if (next.length === existing.length) {
      return false;
    }
    await writeContacts(file, next);
    return true;
  });
}

export async function queryContacts(file: string): Promise<readonly Contact[]> {
  const all = await readContacts(file);
  return [...all].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
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
  const q = query.trim().toLowerCase();
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
    ...(contact.birthday ? { birthday: contact.birthday } : {})
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
  return da === db || da.endsWith(db) || db.endsWith(da);
}

function matchesExact(contact: Contact, q: string): boolean {
  return contact.name.toLowerCase() === q
    || (contact.aliases?.some((alias) => alias.toLowerCase() === q) ?? false)
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
  return contact.name.toLowerCase().includes(q)
    || (contact.aliases?.some((alias) => alias.toLowerCase().includes(q)) ?? false);
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
  return {
    id: c.id,
    name: c.name,
    ...(email !== undefined ? { email } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(birthday !== undefined ? { birthday } : {})
  };
}
