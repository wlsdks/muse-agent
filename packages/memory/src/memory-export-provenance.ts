import {
  beliefProvenanceSourceId,
  projectTemporalBeliefProvenance,
  type BeliefProvenance
} from "./belief-provenance-store.js";
import {
  exactUserMemoryId,
  type ExactUserMemoryEntry
} from "./memory-user-store-file.js";
import { normalizeMemoryKey } from "./memory-user-store.js";

export const MEMORY_EXPORT_PROVENANCE_SCHEMA = "muse.memory-export-provenance/v1" as const;

export interface MemoryExportProvenanceLink {
  readonly exactId: string;
  readonly key: string;
  readonly sourceId: string;
  readonly state: "active" | "historical" | "invalidated";
  readonly version: number;
}

export interface MemoryExportProvenanceIssue {
  readonly code: "ambiguous-current-link" | "ambiguous-initial-version" | "malformed-history" | "missing-current-link" | "missing-version-link";
  readonly exactId?: string;
  readonly key?: string;
  readonly sourceId?: string;
}

export interface MemoryExportProvenanceReport {
  readonly complete: boolean;
  readonly issues: readonly MemoryExportProvenanceIssue[];
  readonly links: readonly MemoryExportProvenanceLink[];
  readonly schemaVersion: typeof MEMORY_EXPORT_PROVENANCE_SCHEMA;
  readonly userId: string;
}

/**
 * Strict export audit. It links only versions the current stores can prove:
 * one unambiguous initial assertion is v1, owner keep is expected+1, and owner
 * invalidation is expected. Plain later corrections/retractions remain
 * incomplete instead of receiving an invented version.
 */
export function projectMemoryExportProvenanceCompleteness(
  userId: string,
  targets: readonly ExactUserMemoryEntry[],
  entries: readonly BeliefProvenance[]
): MemoryExportProvenanceReport {
  const issues: MemoryExportProvenanceIssue[] = [];
  const links: MemoryExportProvenanceLink[] = [];
  if (
    typeof userId !== "string" || userId.length === 0
    || !Array.isArray(targets) || !Array.isArray(entries)
    || !targets.every((target) =>
      normalizeMemoryKey(target.key) === target.key
      && target.exactId === exactUserMemoryId(userId, target.kind, target.key)
      && Number.isSafeInteger(target.version) && target.version >= 1
    )
    || new Set(targets.map((target) => target.exactId)).size !== targets.length
  ) {
    return freezeReport(userId, [], [{ code: "malformed-history" }]);
  }

  const scoped = entries.filter((entry) => entry.userId === userId);
  const temporal = projectTemporalBeliefProvenance(userId, entries, {
    normalizeKey: normalizeMemoryKey
  });
  if (scoped.length > 0 && temporal.length === 0) {
    return freezeReport(userId, [], [{ code: "malformed-history" }]);
  }

  const firstEvents = new Map<string, readonly string[]>();
  for (const event of temporal) {
    const identity = `${event.kind}\u0000${event.key}`;
    const prior = firstEvents.get(identity);
    if (!prior) {
      firstEvents.set(identity, [event.sourceId]);
      continue;
    }
    const first = temporal.find((candidate) => candidate.sourceId === prior[0])!;
    if (event.validFrom === first.validFrom) {
      firstEvents.set(identity, [...prior, event.sourceId]);
    }
  }

  for (const event of temporal) {
    const raw = scoped.find((entry) => beliefProvenanceSourceId(entry) === event.sourceId);
    if (!raw) {
      issues.push({ code: "malformed-history", sourceId: event.sourceId });
      continue;
    }
    const exactId = raw.ownerResolution?.exactId
      ?? exactUserMemoryId(userId, raw.kind, normalizeMemoryKey(raw.key));
    let version: number | undefined;
    if (raw.ownerResolution?.action === "keep") {
      version = raw.ownerResolution.expectedVersion + 1;
    } else if (raw.ownerResolution?.action === "invalidate") {
      version = raw.ownerResolution.expectedVersion;
    } else if (event.event === "assertion") {
      const identity = `${event.kind}\u0000${event.key}`;
      const first = firstEvents.get(identity) ?? [];
      if (first.length === 1 && first[0] === event.sourceId) version = 1;
      else if (first.includes(event.sourceId)) {
        issues.push({ code: "ambiguous-initial-version", exactId, key: event.key, sourceId: event.sourceId });
      }
    }
    if (version === undefined) {
      issues.push({ code: "missing-version-link", exactId, key: event.key, sourceId: event.sourceId });
      continue;
    }
    links.push({
      exactId,
      key: event.key,
      sourceId: event.sourceId,
      state: event.temporalState === "active" ? "active"
        : event.temporalState === "invalidated" ? "invalidated" : "historical",
      version
    });
  }

  for (const target of targets) {
    const currentLinks = links.filter((link) =>
      link.exactId === target.exactId
      && link.version === target.version
      && (link.state === "active" || link.state === "invalidated")
    );
    if (currentLinks.length === 0) {
      issues.push({ code: "missing-current-link", exactId: target.exactId, key: target.key });
    } else if (currentLinks.length > 1) {
      issues.push({ code: "ambiguous-current-link", exactId: target.exactId, key: target.key });
    }
  }
  return freezeReport(userId, links, issues);
}

function freezeReport(
  userId: string,
  links: readonly MemoryExportProvenanceLink[],
  issues: readonly MemoryExportProvenanceIssue[]
): MemoryExportProvenanceReport {
  const sortedLinks = [...links].sort((left, right) =>
    left.exactId.localeCompare(right.exactId)
    || left.version - right.version
    || left.sourceId.localeCompare(right.sourceId)
  ).map((link) => Object.freeze({ ...link }));
  const sortedIssues = [...issues].sort((left, right) =>
    left.code.localeCompare(right.code)
    || (left.exactId ?? "").localeCompare(right.exactId ?? "")
    || (left.sourceId ?? "").localeCompare(right.sourceId ?? "")
  ).map((issue) => Object.freeze({ ...issue }));
  return Object.freeze({
    complete: sortedIssues.length === 0,
    issues: Object.freeze(sortedIssues),
    links: Object.freeze(sortedLinks),
    schemaVersion: MEMORY_EXPORT_PROVENANCE_SCHEMA,
    userId
  });
}
