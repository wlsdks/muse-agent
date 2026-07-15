import { resolveCapabilityProfile } from "./capability-profile.js";

const TOOL_EXPOSURE_AUTHORITY_BRAND = Symbol("muse.toolExposureAuthority");

/**
 * An opaque token issued only by trusted server code. Its runtime authority is
 * held in a private WeakMap, so a request body, object spread, or JSON round
 * trip cannot manufacture one.
 */
export type ToolExposureAuthority = object & {
  readonly [TOOL_EXPOSURE_AUTHORITY_BRAND]: true;
};

export interface ToolExposureAuthorityInput {
  readonly allowedToolNames?: readonly string[];
  readonly localMode?: boolean;
  readonly profileId?: string;
}

export interface ResolvedToolExposureAuthority {
  readonly allowedToolNames: readonly string[];
  readonly localMode: boolean;
  readonly profileId?: string;
}

const authorityRecords = new WeakMap<object, ResolvedToolExposureAuthority>();

function copyToolNames(toolNames: readonly string[] | undefined): readonly string[] {
  return Object.freeze([
    ...new Set((toolNames ?? []).filter((name) => typeof name === "string" && name.trim().length > 0))
  ]);
}

function normalizedProfileId(profileId: string | undefined): string | undefined {
  if (typeof profileId !== "string") {
    return undefined;
  }
  const trimmed = profileId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Creates an immutable token whose authority cannot survive serialization. */
export function createToolExposureAuthority(input: ToolExposureAuthorityInput = {}): ToolExposureAuthority {
  const token = Object.freeze({ [TOOL_EXPOSURE_AUTHORITY_BRAND]: true }) as const;
  const profileId = normalizedProfileId(input.profileId);
  const record = Object.freeze({
    allowedToolNames: copyToolNames(input.allowedToolNames),
    localMode: input.localMode === true,
    ...(profileId ? { profileId } : {})
  });
  authorityRecords.set(token, record);
  return token;
}

/** Resolves only a token produced by {@link createToolExposureAuthority}. */
export function resolveToolExposureAuthority(value: unknown): ResolvedToolExposureAuthority | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return authorityRecords.get(value);
}

/**
 * Produces the final positive allowlist for one genuine authority. A profile
 * can only narrow the generic list; neither profile nor generic list may be
 * widened by request metadata.
 */
export function selectToolNamesForExposureAuthority(
  authority: ResolvedToolExposureAuthority,
  availableToolNames: readonly string[]
): readonly string[] {
  const available = new Set(availableToolNames);
  const genericAllowed = new Set(authority.allowedToolNames);

  if (!authority.profileId) {
    return authority.allowedToolNames.filter((toolName) => available.has(toolName));
  }

  const profile = resolveCapabilityProfile(authority.profileId);
  if (!profile) {
    return [];
  }

  return profile.allowedToolNames.filter(
    (toolName) => genericAllowed.has(toolName) && available.has(toolName)
  );
}
