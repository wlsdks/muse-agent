/**
 * `muse journey` — pure merge logic for the cross-store "what Muse learned
 * about you" timeline. Facts (validity-chain supersessions + retractions),
 * authored skills (authoredAt / lastUsedAt), and playbook strategies
 * (createdAt / lastReinforcedAt) are three separately-shaped stores; this
 * module expands each into a common {@link JourneyEvent} shape and merges
 * them newest-first. Never invents a timestamp — a fact with no history
 * (`steps: []`) and no `forgottenAt` contributes nothing.
 */

import { beliefValueTimeline, keysWithActiveRetraction, type BeliefProvenance } from "@muse/memory";

export type JourneyStoreKind = "fact" | "skill" | "strategy";
export type JourneyEventKind = "learned" | "updated" | "superseded" | "forgotten" | "skill" | "strategy";

export interface JourneyEvent {
  readonly at: string;
  readonly storeKind: JourneyStoreKind;
  readonly eventKind: JourneyEventKind;
  readonly content: string;
  readonly ref?: string;
}

export interface JourneyFactValueStep {
  readonly value: string;
  readonly at: string;
}

export interface JourneyFactRecord {
  readonly key: string;
  /** Value change points, oldest→newest (e.g. from `beliefValueTimeline`). Empty = no recorded history for this key. */
  readonly steps: readonly JourneyFactValueStep[];
  /** ISO timestamp of the most recent active retraction (explicit forget), if any. */
  readonly forgottenAt?: string;
}

/**
 * Group a user's raw belief-provenance log into one {@link JourneyFactRecord}
 * per key — the shared CLI/API transform, so `muse journey` and `GET
 * /api/journey` never re-derive this differently. Uses the same
 * `beliefValueTimeline` change-point detection and `keysWithActiveRetraction`
 * newest-event rule the CLI's `memory why` / `memory history` already trust.
 */
export function factRecordsFromProvenance(entries: readonly BeliefProvenance[]): readonly JourneyFactRecord[] {
  const forgottenKeys = keysWithActiveRetraction(entries);
  const byKey = new Map<string, BeliefProvenance[]>();
  for (const entry of entries) {
    const list = byKey.get(entry.key) ?? [];
    list.push(entry);
    byKey.set(entry.key, list);
  }
  const out: JourneyFactRecord[] = [];
  for (const [key, group] of byKey) {
    const steps = beliefValueTimeline(group, key).map((step) => ({ at: step.learnedAt, value: step.value }));
    let forgottenAt: string | undefined;
    if (forgottenKeys.has(key)) {
      const retractions = group
        .filter((e) => e.retraction === true)
        .sort((a, b) => Date.parse(b.learnedAt) - Date.parse(a.learnedAt));
      forgottenAt = retractions[0]?.learnedAt;
    }
    out.push({ key, steps, ...(forgottenAt ? { forgottenAt } : {}) });
  }
  return out;
}

export interface JourneySkillRecord {
  readonly name: string;
  readonly description?: string;
  readonly authoredAt?: string;
  readonly lastUsedAt?: string;
}

export interface JourneyStrategyRecord {
  readonly id: string;
  readonly text: string;
  readonly createdAt?: string;
  readonly lastReinforcedAt?: string;
}

export interface MergeJourneyEventsInput {
  readonly facts?: readonly JourneyFactRecord[];
  readonly skills?: readonly JourneySkillRecord[];
  readonly strategies?: readonly JourneyStrategyRecord[];
  readonly kind?: JourneyStoreKind;
  /** ISO timestamp — inclusive lower bound. */
  readonly since?: string;
  readonly limit?: number;
}

export const DEFAULT_JOURNEY_LIMIT = 50;

function factEvents(record: JourneyFactRecord): JourneyEvent[] {
  const out: JourneyEvent[] = [];
  const [first, ...rest] = record.steps;
  if (first) {
    out.push({
      at: first.at,
      content: `${record.key}: ${first.value}`,
      eventKind: "learned",
      ref: record.key,
      storeKind: "fact"
    });
  }
  let previousValue = first?.value;
  for (const step of rest) {
    out.push({
      at: step.at,
      content: `${record.key}: "${previousValue ?? ""}" → "${step.value}"`,
      eventKind: "superseded",
      ref: record.key,
      storeKind: "fact"
    });
    previousValue = step.value;
  }
  if (record.forgottenAt) {
    out.push({
      at: record.forgottenAt,
      content: `${record.key}: forgotten`,
      eventKind: "forgotten",
      ref: record.key,
      storeKind: "fact"
    });
  }
  return out;
}

function skillEvents(record: JourneySkillRecord): JourneyEvent[] {
  const out: JourneyEvent[] = [];
  if (record.authoredAt) {
    out.push({
      at: record.authoredAt,
      content: `authored skill "${record.name}"${record.description ? `: ${record.description}` : ""}`,
      eventKind: "skill",
      ref: record.name,
      storeKind: "skill"
    });
  }
  if (record.lastUsedAt && record.lastUsedAt !== record.authoredAt) {
    out.push({
      at: record.lastUsedAt,
      content: `used skill "${record.name}"`,
      eventKind: "updated",
      ref: record.name,
      storeKind: "skill"
    });
  }
  return out;
}

function strategyEvents(record: JourneyStrategyRecord): JourneyEvent[] {
  const out: JourneyEvent[] = [];
  if (record.createdAt) {
    out.push({
      at: record.createdAt,
      content: `learned strategy: "${record.text}"`,
      eventKind: "strategy",
      ref: record.id,
      storeKind: "strategy"
    });
  }
  if (record.lastReinforcedAt && record.lastReinforcedAt !== record.createdAt) {
    out.push({
      at: record.lastReinforcedAt,
      content: `reinforced strategy: "${record.text}"`,
      eventKind: "updated",
      ref: record.id,
      storeKind: "strategy"
    });
  }
  return out;
}

function compareEvents(a: JourneyEvent, b: JourneyEvent): number {
  const byTime = Date.parse(b.at) - Date.parse(a.at);
  if (byTime !== 0) return byTime;
  const byStore = a.storeKind.localeCompare(b.storeKind);
  if (byStore !== 0) return byStore;
  const byRef = (a.ref ?? "").localeCompare(b.ref ?? "");
  if (byRef !== 0) return byRef;
  return a.eventKind.localeCompare(b.eventKind);
}

/** Merge already-loaded per-store event records into one sorted, filtered, capped timeline. Pure. */
export function mergeJourneyEvents(input: MergeJourneyEventsInput): readonly JourneyEvent[] {
  const all: JourneyEvent[] = [
    ...(input.facts ?? []).flatMap(factEvents),
    ...(input.skills ?? []).flatMap(skillEvents),
    ...(input.strategies ?? []).flatMap(strategyEvents)
  ];
  const sinceMs = input.since ? Date.parse(input.since) : undefined;
  const filtered = all.filter((event) => {
    if (input.kind && event.storeKind !== input.kind) return false;
    if (sinceMs !== undefined && Number.isFinite(sinceMs)) {
      const eventMs = Date.parse(event.at);
      if (!Number.isFinite(eventMs) || eventMs < sinceMs) return false;
    }
    return true;
  });
  filtered.sort(compareEvents);
  const limit = Number.isFinite(input.limit) && (input.limit ?? 0) > 0 ? Math.trunc(input.limit as number) : DEFAULT_JOURNEY_LIMIT;
  return filtered.slice(0, limit);
}

export interface JourneyForgetTarget {
  readonly storeKind: JourneyStoreKind;
  readonly ref: string;
}

/**
 * Resolve a user-typed ref (`muse journey forget <ref>`) against an already-merged
 * timeline — exact ref match first, else a prefix match (a playbook id is long;
 * `muse playbook list` / `muse journey` both show a truncated prefix). Pure.
 */
export function resolveJourneyForgetTarget(events: readonly JourneyEvent[], ref: string): JourneyForgetTarget | undefined {
  const exact = events.find((e) => e.ref === ref);
  if (exact?.ref) return { ref: exact.ref, storeKind: exact.storeKind };
  const prefixed = events.find((e) => e.ref?.startsWith(ref));
  if (prefixed?.ref) return { ref: prefixed.ref, storeKind: prefixed.storeKind };
  return undefined;
}
