import type { ContinuityPack } from "@muse/attunement";
import type {
  ContinuityScopedSourceObservationReceipt
} from "@muse/attunement/continuity-source-observations";

import type { ContinuityObservationReceipt } from "./continuity-observation.js";

export type RuntimeMagShadowDecisionEvidence = Readonly<{
  readonly coordinator: object;
  readonly pack: ContinuityPack;
  readonly packDigest: string;
  readonly resumeResultDigest: string;
  readonly previousSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly previousGraphObservationReceipt: ContinuityObservationReceipt;
  readonly currentSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly currentGraphObservationReceipt: ContinuityObservationReceipt;
}>;

const RUNTIME_EVIDENCE = new WeakMap<object, RuntimeMagShadowDecisionEvidence>();
const COORDINATOR_IDENTITIES = new WeakMap<object, object>();

export function bindMagShadowDecisionCoordinator<T extends object>(
  coordinator: T,
  identity: object
): T {
  COORDINATOR_IDENTITIES.set(coordinator, identity);
  return coordinator;
}

export function isMagShadowDecisionCoordinator(
  coordinator: unknown,
  identity: object
): boolean {
  return typeof coordinator === "object"
    && coordinator !== null
    && COORDINATOR_IDENTITIES.get(coordinator) === identity;
}

export function bindMagShadowDecisionRuntimeEvidence<T extends object>(
  result: T,
  evidence: RuntimeMagShadowDecisionEvidence
): T {
  RUNTIME_EVIDENCE.set(result, evidence);
  return result;
}

export function getMagShadowDecisionRuntimeEvidence(
  result: unknown
): RuntimeMagShadowDecisionEvidence | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return RUNTIME_EVIDENCE.get(result);
}
