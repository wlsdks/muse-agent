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

import { levenshteinDistance } from "@muse/shared";

/** A note's link key for resolution: basename without extension, lowercased. */
export function noteLinkKey(id: string): string {
  const base = id.split(/[\\/]/u).pop() ?? id;
  return base.replace(/\.(md|markdown|txt)$/iu, "").trim().toLowerCase();
}

export interface LinkFix {
  /** The broken `[[target]]` text, as written. */
  readonly from: string;
  /** The existing note id it should snap to. */
  readonly to: string;
  readonly distance: number;
}

/**
 * Plan repairs for broken `[[wiki-links]]`: snap each broken target to its
 * closest existing note id, but ONLY when there is exactly ONE candidate within
 * `maxDistance` edits — an ambiguous typo (two equally-close notes) or a target
 * with no near match is left UNRESOLVED rather than silently mis-linked to the
 * wrong note. Case-insensitive; targets deduped. Pure — the deterministic core
 * of `muse notes fix-links`.
 */
export function planLinkFixes(
  brokenTargets: readonly string[],
  existingIds: readonly string[],
  maxDistance = 2
): { readonly fixes: readonly LinkFix[]; readonly unresolved: readonly string[] } {
  const fixes: LinkFix[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const target of brokenTargets) {
    const key = noteLinkKey(target);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    let best: string[] = [];
    let bestDistance = maxDistance + 1;
    for (const id of existingIds) {
      const distance = levenshteinDistance(key, noteLinkKey(id));
      if (distance > maxDistance) {
        continue;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [id];
      } else if (distance === bestDistance) {
        best.push(id);
      }
    }
    if (best.length === 1) {
      fixes.push({ distance: bestDistance, from: target, to: best[0]! });
    } else {
      unresolved.push(target);
    }
  }
  return { fixes, unresolved };
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

/**
 * Rewrite every `[[oldTarget]]` reference in a note body to `[[newTarget]]`,
 * preserving any `|alias` and `#section` suffix and matching the target
 * case-insensitively (same key rule as `extractWikiLinks`). Returns the rewritten
 * body and how many links changed. Pure — the deterministic core of
 * `muse notes rename`, so a renamed note never silently orphans its backlinks.
 */
export function rewriteWikiLinkReferences(body: string, oldTarget: string, newTarget: string): { readonly body: string; readonly count: number } {
  // Match by noteLinkKey so an extension-qualified [[a.md]] link is rewritten
  // when renaming "a" (renameNoteWithLinkRewrite passes the basename-stripped
  // target) — else the rename silently orphans that backlink. Consistent with
  // the rest of the link graph (keyToId / audit / bridges all key by noteLinkKey).
  const oldKey = noteLinkKey(oldTarget);
  if (oldKey.length === 0) {
    return { body, count: 0 };
  }
  let count = 0;
  const rewritten = body.replace(/\[\[([^\]]+)\]\]/gu, (full: string, inner: string) => {
    const suffixIdx = inner.search(/[|#]/u);
    const target = (suffixIdx === -1 ? inner : inner.slice(0, suffixIdx)).trim();
    if (noteLinkKey(target) !== oldKey) {
      return full;
    }
    count += 1;
    const suffix = suffixIdx === -1 ? "" : inner.slice(suffixIdx);
    return `[[${newTarget}${suffix}]]`;
  });
  return { body: rewritten, count };
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
      const key = noteLinkKey(target);
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
    const resolvedId = graph.keyToId.get(noteLinkKey(target));
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
      const resolvedId = graph.keyToId.get(noteLinkKey(target));
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

/**
 * Graph-augmented recall for `muse ask`: build the link graph from the SAME index
 * note bodies the ask ranks (so note ids == the ask's relativized sources, exact
 * match), then return the note ids 1-hop LINKED from the confident `seedRefs`,
 * deduped, excluding the seeds, capped — the answer-bearing note the question
 * links to but whose own text didn't match the query (GraphRAG / HippoRAG). Pure:
 * the caller promotes each ref's best ranked chunk into the grounding evidence.
 */
export function linkExpandRefs(args: {
  readonly seedRefs: readonly string[];
  readonly noteBodies: readonly { readonly id: string; readonly body: string }[];
  readonly cap?: number;
}): string[] {
  const cap = args.cap ?? 2;
  if (cap <= 0 || args.seedRefs.length === 0) {
    return [];
  }
  return linkedFromResults(args.seedRefs, buildNoteLinkGraph(args.noteBodies), cap);
}

export interface NoteGraphAudit {
  /** Note ids with no inbound AND no outbound links — disconnected islands. */
  readonly orphans: readonly string[];
  /** Note ids OTHERS link to but which link OUT to nothing — referenced dead-ends / stubs worth expanding. */
  readonly terminals: readonly string[];
  /** Outbound `[[targets]]` that resolve to no note in the corpus. */
  readonly brokenLinks: readonly { readonly source: string; readonly target: string }[];
}

/**
 * Corpus-wide link-graph health (Zettelkasten hygiene): orphan notes (no
 * links in or out — knowledge that's fallen off the graph), TERMINAL notes
 * (linked-to but linking nowhere — referenced stubs worth developing), and
 * broken links (a `[[target]]` pointing at a note that doesn't exist). All
 * sorted for stable output.
 */
export function auditNoteGraph(graph: NoteLinkGraph): NoteGraphAudit {
  const orphans: string[] = [];
  const terminals: string[] = [];
  const brokenLinks: { source: string; target: string }[] = [];
  for (const [id, targets] of graph.outbound) {
    const inboundCount = (graph.backlinks.get(noteLinkKey(id)) ?? []).length;
    if (targets.length === 0) {
      (inboundCount === 0 ? orphans : terminals).push(id);
    }
    for (const target of targets) {
      if (!graph.keyToId.has(noteLinkKey(target))) {
        brokenLinks.push({ source: id, target });
      }
    }
  }
  orphans.sort((a, b) => a.localeCompare(b));
  terminals.sort((a, b) => a.localeCompare(b));
  brokenLinks.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  return { brokenLinks, orphans, terminals };
}

/** Resolve a user query (exact id or a name/stem) to a note id present in the graph. */
export function resolveNoteId(graph: NoteLinkGraph, query: string): string | undefined {
  const trimmed = query.trim();
  if (graph.outbound.has(trimmed)) {
    return trimmed;
  }
  return graph.keyToId.get(noteLinkKey(trimmed));
}
