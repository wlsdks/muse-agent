import { sha256Hex } from "@muse/shared";

import type { ContinuityPolicy } from "./types.js";

/**
 * Exact, provider-neutral identity for the Continuity policy presented by one
 * delivery. The version is included because it is part of the concurrency and
 * audit snapshot even when the visible presentation fields are unchanged.
 */
export function fingerprintContinuityPolicy(policy: ContinuityPolicy): string {
  return sha256Hex(JSON.stringify([
    "muse.continuity-policy.v1",
    policy.detail,
    policy.nextStep,
    policy.suppression,
    policy.version
  ]));
}
