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
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly handle?: string;
  readonly aliases?: readonly string[];
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
  return (parsed as { contacts: unknown[] }).contacts.flatMap((entry): readonly Contact[] =>
    isContact(entry) ? [entry] : []
  );
}

export async function writeContacts(file: string, contacts: readonly Contact[]): Promise<void> {
  const payload = `${JSON.stringify({ contacts }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/** Add a contact. Idempotent on `id`: re-adding the same id REPLACES. */
export async function addContact(file: string, contact: Contact): Promise<void> {
  const existing = await readContacts(file);
  const filtered = existing.filter((entry) => entry.id !== contact.id);
  await writeContacts(file, [...filtered, contact]);
}

export async function removeContact(file: string, id: string): Promise<boolean> {
  const existing = await readContacts(file);
  const next = existing.filter((entry) => entry.id !== id);
  if (next.length === existing.length) {
    return false;
  }
  await writeContacts(file, next);
  return true;
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
    ...(contact.aliases && contact.aliases.length > 0 ? { aliases: [...contact.aliases] } : {})
  };
}

function matchesExact(contact: Contact, q: string): boolean {
  return contact.name.toLowerCase() === q
    || (contact.aliases?.some((alias) => alias.toLowerCase() === q) ?? false);
}

function matchesPartial(contact: Contact, q: string): boolean {
  return contact.name.toLowerCase().includes(q)
    || (contact.aliases?.some((alias) => alias.toLowerCase().includes(q)) ?? false);
}

function isContact(value: unknown): value is Contact {
  if (!value || typeof value !== "object") {
    return false;
  }
  const c = value as Contact;
  return typeof c.id === "string" && typeof c.name === "string";
}
