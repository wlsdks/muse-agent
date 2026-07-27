import { isGoalKey, isVetoKey } from "@muse/agent-core";
import {
  FACT_RECALL_LIFECYCLE_POLICY_V1,
  defaultBeliefProvenanceFile,
  inspectBeliefProvenanceSource,
  normalizeMemoryKey,
  projectFactRecallLifecycle,
  type BeliefProvenanceStore,
  type FactRecallCandidate,
  type FactRecallDecision,
  type UserMemory
} from "@muse/memory";

export interface AskMemoryRecallAuthority {
  readonly decisions: readonly FactRecallDecision[];
  readonly memory: UserMemory | undefined;
  readonly status: "not-applicable" | "verified" | "unavailable";
}

/**
 * Bind the flat user-memory snapshot to the append-only provenance authority
 * before persona construction, matching, or citation admission.
 *
 * Deleted and superseded candidates are removed from every answer-evidence
 * path. An unreadable authority fails closed for recallable facts/preferences
 * while preserving veto/goal rules, which are safety/behaviour constraints
 * rather than factual answer evidence.
 */
export async function resolveAskMemoryRecallAuthority(
  memory: UserMemory | undefined,
  userId: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly provenanceStore?: Pick<BeliefProvenanceStore, "query">;
  } = {}
): Promise<AskMemoryRecallAuthority> {
  if (!memory) return { decisions: [], memory: undefined, status: "not-applicable" };
  const candidates = memoryRecallCandidates(memory);
  if (candidates.length === 0) return { decisions: [], memory, status: "verified" };

  let entries;
  if (options.provenanceStore) {
    try {
      entries = await options.provenanceStore.query(userId);
    } catch {
      return unavailableAuthority(memory, candidates);
    }
  } else {
    const inspection = await inspectBeliefProvenanceSource(
      defaultBeliefProvenanceFile(options.env),
      options.env
    );
    if (inspection.result === "absent") {
      entries = [];
    } else if (
      inspection.result !== "available"
      || inspection.value.excludedCount > 0
    ) {
      return unavailableAuthority(memory, candidates);
    } else {
      entries = inspection.value.entries.filter((entry) => entry.userId === userId);
    }
  }

  const decisions = projectFactRecallLifecycle(candidates, entries, { normalizeKey: normalizeMemoryKey });
  return {
    decisions,
    memory: filterRecallableMemory(memory, decisions),
    status: "verified"
  };
}

function unavailableAuthority(
  memory: UserMemory,
  candidates: readonly FactRecallCandidate[]
): AskMemoryRecallAuthority {
  const decisions = Object.freeze(candidates.map((candidate): FactRecallDecision => Object.freeze({
    eligibility: "ineligible",
    key: candidate.key,
    kind: candidate.kind,
    policyVersion: FACT_RECALL_LIFECYCLE_POLICY_V1,
    reason: "authority-unavailable",
    state: "disputed"
  })));
  return {
    decisions,
    memory: filterRecallableMemory(memory, decisions),
    status: "unavailable"
  };
}

function memoryRecallCandidates(memory: UserMemory): readonly FactRecallCandidate[] {
  return [
    ...Object.entries(memory.facts).map(([key, value]): FactRecallCandidate => ({ key, kind: "fact", value })),
    ...Object.entries(memory.preferences)
      .filter(([key]) => !isVetoKey(key) && !isGoalKey(key))
      .map(([key, value]): FactRecallCandidate => ({ key, kind: "preference", value }))
  ];
}

function filterRecallableMemory(
  memory: UserMemory,
  decisions: readonly FactRecallDecision[]
): UserMemory {
  const ineligible = new Set(decisions
    .filter((decision) => decision.eligibility === "ineligible")
    .map((decision) => decisionIdentity(decision.kind, decision.key)));
  if (ineligible.size === 0) return memory;
  return {
    ...memory,
    facts: Object.fromEntries(Object.entries(memory.facts).filter(([key]) =>
      !ineligible.has(decisionIdentity("fact", key))
    )),
    preferences: Object.fromEntries(Object.entries(memory.preferences).filter(([key]) =>
      isVetoKey(key)
      || isGoalKey(key)
      || !ineligible.has(decisionIdentity("preference", key))
    ))
  };
}

function decisionIdentity(kind: "fact" | "preference", key: string): string {
  return `${kind}\u0000${normalizeMemoryKey(key)}`;
}
