export const CONTINUITY_EVIDENCE_CLASSES = ["organic", "controlled", "unclassified"] as const;
export type ContinuityEvidenceClass = (typeof CONTINUITY_EVIDENCE_CLASSES)[number];

export type ContinuityWriteAuthority = object & { readonly __continuityWriteAuthority?: never };

export interface ContinuityEvidenceWriteOptions {
  readonly evidenceAuthority?: unknown;
  /** General callers may explicitly mark fixtures controlled; organic requires opaque authority. */
  readonly evidenceClass?: "controlled";
}

const authorityClasses = new WeakMap<object, ContinuityEvidenceClass>();

function createAuthority(evidenceClass: ContinuityEvidenceClass): ContinuityWriteAuthority {
  const authority = Object.freeze({}) as ContinuityWriteAuthority;
  authorityClasses.set(authority, evidenceClass);
  return authority;
}

/** Minted only by trusted production composition roots; serialization destroys it. */
export function createOrganicContinuityWriteAuthority(): ContinuityWriteAuthority {
  return createAuthority("organic");
}

/** Package-internal replay seam for already-validated durable provenance. */
export function createPersistedContinuityWriteAuthority(
  evidenceClass: ContinuityEvidenceClass
): ContinuityWriteAuthority {
  return createAuthority(evidenceClass);
}

export function resolveContinuityEvidenceClass(options: ContinuityEvidenceWriteOptions = {}): ContinuityEvidenceClass {
  if (options.evidenceAuthority && typeof options.evidenceAuthority === "object") {
    const authorized = authorityClasses.get(options.evidenceAuthority);
    if (authorized) return authorized;
  }
  return options.evidenceClass === "controlled" ? "controlled" : "unclassified";
}
