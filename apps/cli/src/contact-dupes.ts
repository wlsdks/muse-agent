/**
 * Find likely-duplicate contacts — two cards for the same person that accrue
 * from vCard imports, manual re-adds, or merged address books. Deterministic
 * (no model): a pair is flagged when both cards share a normalized email, phone,
 * handle, or name, in that confidence order. The opt-in audit counterpart to
 * `muse notes conflicts` for the people graph.
 */

import type { Contact } from "@muse/stores";

export interface DuplicatePair {
  readonly a: { readonly id: string; readonly name: string };
  readonly b: { readonly id: string; readonly name: string };
  readonly reason: string;
}

const digitsOnly = (value: string): string => value.replace(/\D/gu, "");

/**
 * Likely-duplicate contact PAIRS, each reported once and labelled by the
 * STRONGEST shared signal (email > phone > handle > name). Name matching is the
 * weakest signal (two genuinely different same-name people would be flagged),
 * acceptable for an opt-in review tool. A phone needs ≥7 digits to count.
 */
export function findDuplicateContacts(contacts: readonly Contact[]): readonly DuplicatePair[] {
  const signals: { readonly label: string; readonly key: (contact: Contact) => string | undefined }[] = [
    { key: (c) => (c.email?.trim().toLowerCase() || undefined), label: "email" },
    { key: (c) => { const d = digitsOnly(c.phone ?? ""); return d.length >= 7 ? d : undefined; }, label: "phone" },
    { key: (c) => (c.handle?.trim().toLowerCase() || undefined), label: "handle" },
    { key: (c) => (c.name?.trim().toLowerCase().replace(/\s+/gu, " ") || undefined), label: "name" }
  ];
  const out: DuplicatePair[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const groups = new Map<string, Contact[]>();
    for (const contact of contacts) {
      const key = signal.key(contact);
      if (!key) continue;
      const arr = groups.get(key);
      if (arr) arr.push(contact);
      else groups.set(key, [contact]);
    }
    for (const [value, members] of groups) {
      if (members.length < 2) continue;
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const a = members[i]!;
          const b = members[j]!;
          const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          out.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name }, reason: `same ${signal.label} (${value})` });
        }
      }
    }
  }
  return out;
}

/** Render the duplicate pairs, or an explicit all-clear line. */
export function formatDuplicateContacts(pairs: readonly DuplicatePair[]): string {
  if (pairs.length === 0) return "✓ No likely-duplicate contacts found.\n";
  const lines = pairs.map((pair) => `  ⚠️ ${pair.a.name} ↔ ${pair.b.name} — ${pair.reason}`);
  return `Found ${pairs.length.toString()} likely-duplicate contact pair(s):\n${lines.join("\n")}\n`;
}
