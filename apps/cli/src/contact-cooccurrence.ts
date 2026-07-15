/**
 * Inferred relationship edges — which people you MENTION TOGETHER in your notes.
 * Pointwise mutual information (Church & Hanks, "Word association norms, mutual
 * information, and lexicography", Computational Linguistics 16(1):22-29, 1990):
 * PMI(A,B) = log2( P(A,B) / (P(A)·P(B)) ) — how much MORE two people co-occur
 * than chance would predict. PMI (not raw co-mention count) is the right signal:
 * it surfaces a SPECIFIC association and demotes a person who appears in almost
 * every note (a partner mentioned everywhere co-occurs with everyone, so their
 * association with any one person is unremarkable). Deterministic, no model —
 * the inferred sibling of the EXPLICIT `muse contacts link` / `network`.
 */

export interface CooccurrenceContact {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

/** Normalize text for whole-word matching: lowercase, punctuation→spaces, padded so a form matches only on word boundaries (Unicode-safe — \b is ASCII-only). */
function normalizePadded(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ")} `;
}

export interface ContactSurface {
  readonly id: string;
  /** The padded, normalized forms by which this contact may be named in a note. */
  readonly forms: readonly string[];
}

type MentionRule = readonly [form: string, contactId: string];

function buildMentionIndex(surfaces: readonly ContactSurface[]): readonly MentionRule[] {
  const index: MentionRule[] = [];
  for (const surface of surfaces) {
    for (const form of surface.forms) {
      index.push([form, surface.id]);
    }
  }
  return index;
}

/**
 * The surface forms each contact may appear as in note text: their full name,
 * every alias, and their distinctive first name (>= 3 chars). A form shared by
 * MORE THAN ONE contact is AMBIGUOUS (e.g. two people named "Sarah") and is
 * dropped from all — so an ambiguous first name never mis-attributes a mention.
 */
export function buildSurfaceForms(contacts: readonly CooccurrenceContact[]): ContactSurface[] {
  const owners = new Map<string, Set<string>>();
  const raw = new Map<string, Set<string>>();
  const add = (id: string, form: string): void => {
    const norm = normalizePadded(form);
    if (norm.trim().length === 0) return;
    const rawSet = raw.get(id) ?? (() => {
      const created = new Set<string>();
      raw.set(id, created);
      return created;
    })();
    const ownerSet = owners.get(norm) ?? (() => {
      const created = new Set<string>();
      owners.set(norm, created);
      return created;
    })();

    rawSet.add(norm);
    ownerSet.add(id);
  };
  for (const contact of contacts) {
    add(contact.id, contact.name);
    for (const alias of contact.aliases ?? []) add(contact.id, alias);
    const firstName = contact.name.trim().split(/\s+/u)[0] ?? "";
    if (firstName.length >= 3 && firstName.toLowerCase() !== contact.name.trim().toLowerCase()) add(contact.id, firstName);
  }
  const out: ContactSurface[] = [];
  for (const contact of contacts) {
    const forms = [...(raw.get(contact.id) ?? [])].filter((form) => (owners.get(form)?.size ?? 0) === 1);
    if (forms.length > 0) out.push({ forms, id: contact.id });
  }
  return out;
}

/** The set of contact ids named in one note body. */
export function mentionedContactIds(noteBody: string, surfaces: readonly ContactSurface[]): Set<string> {
  return mentionedContactIdsByIndex(noteBody, buildMentionIndex(surfaces));
}

function mentionedContactIdsByIndex(noteBody: string, mentionIndex: readonly MentionRule[]): Set<string> {
  if (mentionIndex.length === 0) {
    return new Set<string>();
  }
  const haystack = normalizePadded(noteBody);
  const ids = new Set<string>();
  for (const [form, id] of mentionIndex) {
    if (haystack.includes(form)) {
      ids.add(id);
    }
  }
  return ids;
}

export interface CooccurrenceStats {
  readonly totalNotes: number;
  /** contact id → number of notes mentioning them. */
  readonly perContact: ReadonlyMap<string, number>;
  /** sorted-id-pair key → number of notes mentioning both. */
  readonly perPair: ReadonlyMap<string, number>;
}

// NUL joins the sorted id pair — it can never occur inside a contact id, so the
// key is unambiguous. Written as the \u0000 escape, never a raw control byte.
const PAIR_SEP = "\u0000";
const pairKey = (a: string, b: string): string => (a < b ? `${a}${PAIR_SEP}${b}` : `${b}${PAIR_SEP}${a}`);

/** Accumulate per-contact and per-pair note counts from each note's mention set. Notes naming fewer than one contact still count toward the total. */
export function computeCooccurrence(noteMentionSets: readonly ReadonlySet<string>[]): CooccurrenceStats {
  const perContact = new Map<string, number>();
  const perPair = new Map<string, number>();
  for (const mentions of noteMentionSets) {
    const ids = [...mentions];
    for (const id of ids) perContact.set(id, (perContact.get(id) ?? 0) + 1);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = pairKey(ids[i]!, ids[j]!);
        perPair.set(key, (perPair.get(key) ?? 0) + 1);
      }
    }
  }
  return { perContact, perPair, totalNotes: noteMentionSets.length };
}

export interface RelatedContact {
  readonly id: string;
  /** Notes mentioning both this person and the target. */
  readonly sharedNotes: number;
  /** Pointwise mutual information (log2) — higher = associated more than chance. */
  readonly pmi: number;
}

export interface RelatedOptions {
  /** Minimum notes-in-common to count as an edge (default 1). */
  readonly minShared?: number;
  /** Max related people to return (default 10). */
  readonly limit?: number;
}

/** PMI-ranked people who co-occur with `targetId` in the notes, strongest association first. */
export function relatedContactsByPmi(stats: CooccurrenceStats, targetId: string, options: RelatedOptions = {}): RelatedContact[] {
  const minShared = Math.max(1, Math.trunc(typeof options.minShared === "number" && Number.isFinite(options.minShared) ? options.minShared : 1));
  const limit = Math.max(1, Math.trunc(typeof options.limit === "number" && Number.isFinite(options.limit) ? options.limit : 10));
  const total = stats.totalNotes;
  const targetCount = stats.perContact.get(targetId) ?? 0;
  if (total === 0 || targetCount === 0) return [];
  const out: RelatedContact[] = [];
  for (const [otherId, otherCount] of stats.perContact) {
    if (otherId === targetId) continue;
    const sharedNotes = stats.perPair.get(pairKey(targetId, otherId)) ?? 0;
    if (sharedNotes < minShared) continue;
    // PMI = log2( P(A,B) / (P(A)·P(B)) ) = log2( sharedNotes · total / (targetCount · otherCount) ).
    const pmi = Math.log2((sharedNotes * total) / (targetCount * otherCount));
    out.push({ id: otherId, pmi, sharedNotes });
  }
  return out
    .sort((a, b) => (b.pmi - a.pmi) || (b.sharedNotes - a.sharedNotes) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * One-call inference: given note bodies + contacts + a target id, return the
 * PMI-ranked people most associated with the target in the notes. Pure — the
 * command does the IO (read contacts, read notes) and renders the result.
 */
export function relatedByCooccurrence(args: {
  readonly targetId: string;
  readonly noteBodies: readonly string[];
  readonly contacts: readonly CooccurrenceContact[];
  readonly minShared?: number;
  readonly limit?: number;
}): RelatedContact[] {
  const surfaces = buildSurfaceForms(args.contacts);
  const mentionIndex = buildMentionIndex(surfaces);
  const mentionSets = args.noteBodies.map((body) => mentionedContactIdsByIndex(body, mentionIndex));
  const stats = computeCooccurrence(mentionSets);
  return relatedContactsByPmi(stats, args.targetId, { limit: args.limit, minShared: args.minShared });
}
