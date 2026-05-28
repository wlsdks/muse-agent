/**
 * Wiki-link graph over the notes corpus — Zettelkasten / networked-thought
 * (Luhmann's Zettelkasten; the [[wiki-link]] convention popularised by
 * Obsidian / Roam). A second brain isn't just a bag of passages to
 * retrieve; the LINKS between notes are knowledge. These pure helpers
 * parse `[[target]]` references and build a forward + backward link graph
 * so `muse notes links` can show a note's outbound links and — more
 * usefully — its BACKLINKS (the notes that point at it). Deterministic,
 * no model.
 */

/** A note's link key for resolution: basename without extension, lowercased. */
export function noteLinkKey(id: string): string {
  const base = id.split("/").pop() ?? id;
  return base.replace(/\.(md|markdown|txt)$/iu, "").trim().toLowerCase();
}

/**
 * Extract `[[wiki-link]]` targets from a note body — strips a `|alias`
 * and a `#section` anchor, trims, and dedupes (case-insensitive,
 * order-preserving). An empty target is ignored.
 */
export function extractWikiLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/gu;
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    const raw = (match[1] ?? "").split("|")[0]!.split("#")[0]!.trim();
    match = re.exec(body);
    if (raw.length === 0) {
      continue;
    }
    const key = raw.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(raw);
  }
  return out;
}

export interface NoteLinkGraph {
  /** note id → outbound link targets, as written. */
  readonly outbound: ReadonlyMap<string, readonly string[]>;
  /** link key → note ids that link to it (backlinks). */
  readonly backlinks: ReadonlyMap<string, readonly string[]>;
  /** link key → the actual note id it resolves to (for resolved/unresolved). */
  readonly keyToId: ReadonlyMap<string, string>;
}

export function buildNoteLinkGraph(notes: readonly { readonly id: string; readonly body: string }[]): NoteLinkGraph {
  const outbound = new Map<string, readonly string[]>();
  const backlinks = new Map<string, string[]>();
  const keyToId = new Map<string, string>();
  for (const note of notes) {
    keyToId.set(noteLinkKey(note.id), note.id);
  }
  for (const note of notes) {
    const links = extractWikiLinks(note.body);
    outbound.set(note.id, links);
    for (const target of links) {
      const key = target.toLowerCase();
      const arr = backlinks.get(key) ?? [];
      if (!arr.includes(note.id)) {
        arr.push(note.id);
      }
      backlinks.set(key, arr);
    }
  }
  return { backlinks, keyToId, outbound };
}

export interface NoteLinkView {
  readonly outbound: readonly { readonly target: string; readonly resolvedId?: string }[];
  readonly backlinks: readonly string[];
}

/** One note's outbound links (each flagged resolved/unresolved) + its backlinks (sorted). */
export function noteLinkView(graph: NoteLinkGraph, noteId: string): NoteLinkView {
  const outbound = (graph.outbound.get(noteId) ?? []).map((target) => {
    const resolvedId = graph.keyToId.get(target.toLowerCase());
    return resolvedId ? { resolvedId, target } : { target };
  });
  const backlinks = [...(graph.backlinks.get(noteLinkKey(noteId)) ?? [])].sort((a, b) => a.localeCompare(b));
  return { backlinks, outbound };
}

/**
 * 1-hop graph expansion (GraphRAG, Edge et al. 2024): the notes that the
 * given result notes link to — resolved to real note ids, deduped, and
 * excluding the results themselves — so link structure surfaces related
 * notes the embedding ranking missed. `resultRefs` are note ids/paths,
 * matched to graph nodes by link key (basename stem). Unresolved targets
 * are skipped; capped at `limit`.
 */
export function linkedFromResults(resultRefs: readonly string[], graph: NoteLinkGraph, limit: number): string[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;
  if (cap === 0) {
    return [];
  }
  const resultKeys = new Set(resultRefs.map((ref) => noteLinkKey(ref)));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ref of resultRefs) {
    const nodeId = graph.keyToId.get(noteLinkKey(ref));
    if (!nodeId) {
      continue;
    }
    for (const target of graph.outbound.get(nodeId) ?? []) {
      const resolvedId = graph.keyToId.get(target.toLowerCase());
      if (!resolvedId) {
        continue;
      }
      const key = noteLinkKey(resolvedId);
      if (resultKeys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(resolvedId);
      if (out.length >= cap) {
        return out;
      }
    }
  }
  return out;
}

export interface NoteGraphAudit {
  /** Note ids with no inbound AND no outbound links — disconnected islands. */
  readonly orphans: readonly string[];
  /** Outbound `[[targets]]` that resolve to no note in the corpus. */
  readonly brokenLinks: readonly { readonly source: string; readonly target: string }[];
}

/**
 * Corpus-wide link-graph health (Zettelkasten hygiene): orphan notes (no
 * links in or out — knowledge that's fallen off the graph) and broken
 * links (a `[[target]]` pointing at a note that doesn't exist). Both
 * sorted for stable output.
 */
export function auditNoteGraph(graph: NoteLinkGraph): NoteGraphAudit {
  const orphans: string[] = [];
  const brokenLinks: { source: string; target: string }[] = [];
  for (const [id, targets] of graph.outbound) {
    const inboundCount = (graph.backlinks.get(noteLinkKey(id)) ?? []).length;
    if (targets.length === 0 && inboundCount === 0) {
      orphans.push(id);
    }
    for (const target of targets) {
      if (!graph.keyToId.has(target.toLowerCase())) {
        brokenLinks.push({ source: id, target });
      }
    }
  }
  orphans.sort((a, b) => a.localeCompare(b));
  brokenLinks.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return { brokenLinks, orphans };
}

/** Resolve a user query (exact id or a name/stem) to a note id present in the graph. */
export function resolveNoteId(graph: NoteLinkGraph, query: string): string | undefined {
  const trimmed = query.trim();
  if (graph.outbound.has(trimmed)) {
    return trimmed;
  }
  return graph.keyToId.get(noteLinkKey(trimmed));
}
