import { createHash } from "node:crypto";

import type { ContinuityEvidenceClass } from "./evidence-provenance.js";
import type { ContinuityOutcome } from "./types.js";

export interface ContinuityOutcomeIdentityInput {
  readonly deliveryId: string;
  readonly evidenceClass: ContinuityEvidenceClass;
  readonly outcome: ContinuityOutcome;
  readonly ownerNote?: string;
  readonly recordedAt: string;
  readonly runId?: string;
}

export function continuityOutcomeId(input: ContinuityOutcomeIdentityInput): string {
  return `continuity_outcome_${createHash("sha256")
    .update(JSON.stringify([
      "muse.continuity-outcome.v1",
      input.deliveryId,
      input.runId ?? null,
      input.outcome,
      input.ownerNote ?? null,
      input.recordedAt,
      input.evidenceClass
    ]))
    .digest("hex")}`;
}
