/**
 * The synthetic eval-corpus CONTRACT: version stamps, provenance, the
 * tier/family/locale/complexity axes, and the record + manifest shapes.
 * A LEAF — generation and the I/O layer both import from here, so it must
 * never import back from `index.js`.
 */

export const GENERATOR_VERSION = "v1" as const;
export const SCHEMA_VERSION = 1 as const;
export const EVIDENCE_CLASS = "controlled-synthetic-corpus-integrity" as const;
export const SYNTHETIC_PROVENANCE = {
  dataOrigin: "synthetic" as const,
  organicEvidence: false as const,
  personalLearningEligible: false as const,
  humanOutcome: false as const,
  heldOut: false as const,
  evidenceClass: EVIDENCE_CLASS,
  robustnessReplay: false as const,
};
export const ROBUSTNESS_REPLAY_SEED = 520_057;
export const TIERS = [1_000, 10_000, 100_000, 1_000_000] as const;
export const FAMILIES = [
  "recall-correction",
  "absent-abstention",
  "continuity",
  "memory-preference-veto-correction",
  "tool-policy-approval",
  "context-stress",
] as const;
export const LOCALES = ["en", "ko", "ja", "zh-CN"] as const;
export const COMPLEXITIES = ["simple", "medium", "complex", "long-context"] as const;

export type Tier = (typeof TIERS)[number];
export type Family = (typeof FAMILIES)[number];
export type Locale = (typeof LOCALES)[number];
export type Complexity = (typeof COMPLEXITIES)[number];

type CommonRecord = {
  schemaVersion: typeof SCHEMA_VERSION;
  generatorVersion: typeof GENERATOR_VERSION;
  recordId: string;
  sequence: number;
  tier: Tier;
  seed: number;
  family: Family;
  locale: Locale;
  complexity: Complexity;
  dataOrigin: "synthetic";
  organicEvidence: false;
  personalLearningEligible: false;
  humanOutcome: false;
  heldOut: false;
  evidenceClass: typeof EVIDENCE_CLASS;
  robustnessReplay: boolean;
  topicHash: string;
  contentHash: string;
};

export type RecallCorrectionRecord = CommonRecord & {
  family: "recall-correction";
  payload: {
    templateId: string;
    lexemeId: string;
    scenarioId: string;
    query: string;
    current: string;
    stale: string;
    distractor: string;
  };
  expected: { terminal: "current-before-stale" };
};

export type AbsentAbstentionRecord = CommonRecord & {
  family: "absent-abstention";
  payload: {
    templateId: string;
    lexemeId: string;
    scenarioId: string;
    query: string;
    corpus: string;
  };
  expected: { terminal: "abstain" };
};

export type ContinuityRecord = CommonRecord & {
  family: "continuity";
  payload: {
    templateId: string;
    lexemeId: string;
    scenarioId: string;
    threadTitle: string;
    artifactTitle: string;
  };
  expected: { terminal: "controlled-excluded-from-next" };
};

export type MemoryRecord = CommonRecord & {
  family: "memory-preference-veto-correction";
  payload: {
    templateId: string;
    lexemeId: string;
    scenarioId: string;
    operation: "add" | "update" | "delete" | "noop";
    key: string;
    existing: string;
    incoming: string;
  };
  expected: { terminal: "memory-operation"; operation: "add" | "update" | "delete" | "noop" };
};

export type ToolPolicyRecord = CommonRecord & {
  family: "tool-policy-approval";
  payload: {
    templateId: string;
    lexemeId: string;
    scenarioId: string;
    action: string;
    authorityStatus: "missing" | "expired" | "revoked" | "valid";
    hardDeny: true;
  };
  expected: { terminal: "deny" };
};

export type ContextStressRecord = CommonRecord & {
  family: "context-stress";
  payload: {
    templateId: string;
    lexemeId: string;
    scenarioId: string;
    messages: string[];
    maxContextWindowTokens: number;
    outputReserveTokens: number;
  };
  expected: { terminal: "within-budget"; trimmingRequired: boolean };
};

export type EvalRecord =
  | RecallCorrectionRecord
  | AbsentAbstentionRecord
  | ContinuityRecord
  | MemoryRecord
  | ToolPolicyRecord
  | ContextStressRecord;

export type CellCounts = Record<string, number>;

export type TierManifest = {
  schemaVersion: typeof SCHEMA_VERSION;
  generatorVersion: typeof GENERATOR_VERSION;
  tier: Tier;
  seed: number;
  recordsFile: "records.jsonl";
  recordCount: number;
  serializedCount: number;
  bytes: number;
  corpusSha256: string;
  dataOrigin: "synthetic";
  organicEvidence: false;
  personalLearningEligible: false;
  humanOutcome: false;
  heldOut: false;
  evidenceClass: typeof EVIDENCE_CLASS;
  robustnessReplay: boolean;
  cellCounts: CellCounts;
  familyCounts: Record<Family, number>;
  peakRssBytes: number;
  wallTimeMs: number;
  recordSizeLimitBytes: 16_384;
  absoluteWriterByteCeiling: 1_610_612_736;
  peakRssLimitBytes: 536_870_912;
  tierTimeLimitMs: 300_000;
};

export type ValidationResult = {
  dataOrigin: "synthetic";
  organicEvidence: false;
  personalLearningEligible: false;
  humanOutcome: false;
  heldOut: false;
  evidenceClass: typeof EVIDENCE_CLASS;
  robustnessReplay: boolean;
  manifest: TierManifest;
  generated: number;
  serialized: number;
  parsedAndSchemaValidated: number;
  collisionCounts: { recordId: 0; topicHash: 0; contentHash: 0 };
  sample: EvalRecord[];
  peakRssBytes: number;
  wallTimeMs: number;
};
