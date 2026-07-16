/**
 * Merge Apple Contacts records (from `readAppleContacts`) into the local people
 * graph for `muse contacts import --apple`. Pure + deterministic so the dedup /
 * additive-merge / idempotency semantics are unit-testable without osascript.
 *
 * Dedup matches an incoming person to an existing contact by normalized NAME,
 * or by a digit-matched PHONE, or by a lower-cased EMAIL. On a match the merge
 * is ADDITIVE — it only fills BLANK store fields (email / phone / birthday) and
 * NEVER overwrites a value the user enriched (relationship, about, and any
 * already-set reach field are left exactly as they were). That makes re-running
 * the import converge: a second pass finds every field already present and
 * writes nothing new.
 */

import type { AppleContact } from "@muse/macos";
import type { Contact } from "@muse/stores";

export interface AppleImportResult {
  /** The full next contact list to persist (existing, merged in place, plus new). */
  readonly contacts: readonly Contact[];
  /** New contacts created. */
  readonly imported: number;
  /** Existing contacts that gained a previously-blank field. */
  readonly updated: number;
  /** Incoming rows that changed nothing (already present, or no name+phone/email/birthday). */
  readonly skipped: number;
}

// NFC + full-width-ASCII fold + lowercase — mirrors the store's own name
// normalization so a KO contact stored NFD (macOS) dedups against an NFC read.
function normName(name: string): string {
  return name.trim().normalize("NFC").replace(/[！-～]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase();
}

const digitsOnly = (value: string): string => value.replace(/\D/gu, "");

// Digit-based phone match tolerant of formatting + country-code prefixes (≥7 digits).
function phoneMatches(a: string, b: string): boolean {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length < 7 || db.length < 7) {
    return false;
  }
  return da === db || da.endsWith(db) || db.endsWith(da);
}

const emailNorm = (value: string): string => value.trim().toLowerCase();

function hasStoredAddress(existing: Contact): boolean {
  return existing.phone !== undefined || existing.email !== undefined;
}

function hasIncomingAddress(incoming: AppleContact): boolean {
  return incoming.phones.length > 0 || incoming.emails.length > 0;
}

function addressesMatch(existing: Contact, incoming: AppleContact): boolean {
  if (existing.phone !== undefined && incoming.phones.some((p) => phoneMatches(existing.phone as string, p))) {
    return true;
  }
  if (existing.email !== undefined && incoming.emails.some((e) => emailNorm(e) === emailNorm(existing.email as string))) {
    return true;
  }
  return false;
}

/**
 * An import must not collapse two addressable people merely because they share
 * a display name. Match a unique phone/email first; only use a unique name as
 * a fallback when either side has no address to contradict that inference.
 */
function findMergeTarget(contacts: readonly Contact[], incoming: AppleContact): number | undefined {
  const addressMatches = contacts.flatMap((contact, index) => addressesMatch(contact, incoming) ? [index] : []);
  if (addressMatches.length === 1) {
    return addressMatches[0];
  }
  if (addressMatches.length > 1 || incoming.name.trim().length === 0) {
    return undefined;
  }
  const nameMatches = contacts.flatMap((contact, index) =>
    normName(contact.name) === normName(incoming.name) && (!hasStoredAddress(contact) || !hasIncomingAddress(incoming)) ? [index] : []
  );
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
}

/** Fill only blank reach/birthday fields; never touch name, relationship, about, handle, aliases, connections. */
function mergeInto(existing: Contact, incoming: AppleContact): { readonly next: Contact; readonly changed: boolean } {
  let changed = false;
  const next: Contact = { ...existing };
  const patch = next as { -readonly [K in keyof Contact]: Contact[K] };
  const firstEmail = incoming.emails[0];
  const firstPhone = incoming.phones[0];
  if (existing.email === undefined && firstEmail !== undefined) {
    patch.email = firstEmail;
    changed = true;
  }
  if (existing.phone === undefined && firstPhone !== undefined) {
    patch.phone = firstPhone;
    changed = true;
  }
  if (existing.birthday === undefined && incoming.birthday !== undefined) {
    patch.birthday = incoming.birthday;
    changed = true;
  }
  return { changed, next };
}

/** An incoming row worth storing: has a name AND at least one way to reach OR celebrate them. */
function isReachable(incoming: AppleContact): boolean {
  return incoming.name.trim().length > 0
    && (incoming.phones.length > 0 || incoming.emails.length > 0 || incoming.birthday !== undefined);
}

export function mergeAppleContacts(
  existingList: readonly Contact[],
  incoming: readonly AppleContact[],
  newId: () => string
): AppleImportResult {
  const working: Contact[] = [...existingList];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const person of incoming) {
    if (!isReachable(person)) {
      skipped += 1;
      continue;
    }
    const idx = findMergeTarget(working, person);
    if (idx !== undefined) {
      const { next, changed } = mergeInto(working[idx]!, person);
      if (changed) {
        working[idx] = next;
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    const firstEmail = person.emails[0];
    const firstPhone = person.phones[0];
    working.push({
      id: newId(),
      name: person.name.trim(),
      ...(firstEmail !== undefined ? { email: firstEmail } : {}),
      ...(firstPhone !== undefined ? { phone: firstPhone } : {}),
      ...(person.birthday !== undefined ? { birthday: person.birthday } : {})
    });
    imported += 1;
  }
  return { contacts: working, imported, skipped, updated };
}
