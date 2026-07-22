export interface CapabilityEvidenceAttempt {
  readonly attemptId: string;
  readonly reportPath: string;
  readonly allowedRoot: string;
}

export interface CapabilityEvidenceOptions {
  readonly reportPath?: string;
  readonly allowedRoot?: string;
  readonly attemptId?: string;
  readonly rename?: (from: string, to: string) => void;
  readonly fsync?: (descriptor: number) => void;
}

export interface CapabilityEvidenceInspection {
  readonly artifact: { readonly state: "missing" | "invalid" | "parsed"; readonly value?: unknown };
  readonly fingerprint?: string;
  readonly state: "missing" | "invalid" | "running" | "completed";
  readonly status?: "passed" | "failed" | "unverified";
}

export const CAPABILITY_EVIDENCE_SCHEMA_VERSION: 1;
export const DEFAULT_CAPABILITY_REPORT_PATH: string;

export function beginCapabilityEvidenceAttempt(options?: CapabilityEvidenceOptions): CapabilityEvidenceAttempt;
export function finalizeCapabilityEvidenceAttempt(
  attempt: CapabilityEvidenceAttempt,
  report: unknown,
  options?: CapabilityEvidenceOptions
): void;
export function inspectCapabilityEvidence(options?: CapabilityEvidenceOptions): CapabilityEvidenceInspection;
export function isCanonicalPassingCapabilityReport(report: unknown): boolean;
