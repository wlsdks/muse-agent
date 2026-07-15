/**
 * A capability profile is selected by trusted server code and contains the
 * entire positive allowlist for one agent surface. Request metadata can narrow
 * a profile later, but it can never grant a capability absent from this list.
 */

export const PERSONAL_WORK_CAPABILITY_PROFILE_ID = "personal-work";

export type PersonalWorkCapability =
  | "analyze-user-provided-material"
  | "draft-user-reviewable-artifact"
  | "apply-user-approved-local-work-item";

export type PersonalWorkApprovalOperation =
  | "work.analyze-material"
  | "work.draft-artifact"
  | "work.apply-local-task";

export type PersonalWorkApprovalRisk = "local-write";

export interface CapabilityProfile {
  readonly id: string;
  readonly allowedToolNames: readonly string[];
  readonly allowedApprovalOperations: readonly PersonalWorkApprovalOperation[];
  readonly allowedApprovalRisks: readonly PersonalWorkApprovalRisk[];
  readonly allowsRemoteTarget: boolean;
  readonly permittedWorkCapabilities: readonly PersonalWorkCapability[];
}

export interface CapabilitySelectionRequest {
  readonly metadata?: unknown;
  readonly requestedToolNames?: readonly string[];
}

export interface CapabilityProfileApprovalBinding {
  readonly operation: string;
  readonly risk: string;
  readonly destination: string | null;
  readonly host: string | null;
}

const PERSONAL_WORK_PROFILE: CapabilityProfile = {
  allowedApprovalOperations: [
    "work.analyze-material",
    "work.draft-artifact",
    "work.apply-local-task"
  ],
  allowedApprovalRisks: ["local-write"],
  allowedToolNames: [],
  allowsRemoteTarget: false,
  id: PERSONAL_WORK_CAPABILITY_PROFILE_ID,
  permittedWorkCapabilities: [
    "analyze-user-provided-material",
    "draft-user-reviewable-artifact",
    "apply-user-approved-local-work-item"
  ]
};

const REGISTERED_CAPABILITY_PROFILES = new Map<string, CapabilityProfile>([
  [PERSONAL_WORK_PROFILE.id, PERSONAL_WORK_PROFILE]
]);

function copyProfile(profile: CapabilityProfile): CapabilityProfile {
  return {
    allowedApprovalOperations: [...profile.allowedApprovalOperations],
    allowedApprovalRisks: [...profile.allowedApprovalRisks],
    allowedToolNames: [...profile.allowedToolNames],
    allowsRemoteTarget: profile.allowsRemoteTarget,
    id: profile.id,
    permittedWorkCapabilities: [...profile.permittedWorkCapabilities]
  };
}

/** Returns a server-registered profile only; unknown ids have no capabilities. */
export function resolveCapabilityProfile(profileId: string): CapabilityProfile | undefined {
  const profile = REGISTERED_CAPABILITY_PROFILES.get(profileId);
  return profile ? copyProfile(profile) : undefined;
}

/**
 * Intersects a server-owned positive allowlist with the actually available
 * tools. The untrusted request is intentionally not consulted: caller metadata
 * or a caller-supplied allowlist must never widen a profile.
 */
export function selectAllowedToolNames(
  profileId: string,
  availableToolNames: readonly string[],
  _untrustedRequest: CapabilitySelectionRequest = {}
): readonly string[] {
  const profile = resolveCapabilityProfile(profileId);
  if (!profile) {
    return [];
  }

  const available = new Set(availableToolNames);
  return profile.allowedToolNames.filter((toolName) => available.has(toolName));
}

/** Convenience guard for the runtime enforcement slice that follows T1a. */
export function isToolAllowedForCapabilityProfile(profileId: string, toolName: string): boolean {
  return resolveCapabilityProfile(profileId)?.allowedToolNames.includes(toolName) ?? false;
}

/** Checks an approval receipt's operation against the profile's positive allowlist. */
export function isApprovalOperationAllowedForCapabilityProfile(profileId: string, operation: string): boolean {
  return resolveCapabilityProfile(profileId)?.allowedApprovalOperations.includes(operation as PersonalWorkApprovalOperation) ?? false;
}

/** Validates that a receipt target stays within the capability profile's local boundary. */
export function isApprovalBindingAllowedForCapabilityProfile(
  profileId: string,
  binding: CapabilityProfileApprovalBinding
): boolean {
  const profile = resolveCapabilityProfile(profileId);
  if (!profile) {
    return false;
  }
  if (!profile.allowedApprovalOperations.includes(binding.operation as PersonalWorkApprovalOperation)) {
    return false;
  }
  if (!profile.allowedApprovalRisks.includes(binding.risk as PersonalWorkApprovalRisk)) {
    return false;
  }
  return profile.allowsRemoteTarget || (binding.destination === null && binding.host === null);
}
