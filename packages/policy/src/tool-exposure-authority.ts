import { resolveCapabilityProfile } from "./capability-profile.js";

/**
 * An opaque token issued only by trusted server code. Its runtime authority is
 * held in a private WeakMap, so a request body, object spread, or JSON round
 * trip cannot manufacture one.
 */
export type ToolExposureAuthority = object & {
  readonly __museToolExposureAuthority?: never;
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
  /** Internal ceiling minted only while attenuating an absent parent authority. */
  readonly safeDefaultOnly?: true;
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

function createAuthorityToken(
  input: ToolExposureAuthorityInput,
  safeDefaultOnly = false
): ToolExposureAuthority {
  const token = Object.freeze({}) as ToolExposureAuthority;
  const profileId = normalizedProfileId(input.profileId);
  const record = Object.freeze({
    allowedToolNames: copyToolNames(input.allowedToolNames),
    localMode: input.localMode === true,
    ...(profileId ? { profileId } : {}),
    ...(safeDefaultOnly ? { safeDefaultOnly: true as const } : {})
  });
  authorityRecords.set(token, record);
  return token;
}

/** Creates an immutable token whose authority cannot survive serialization. */
export function createToolExposureAuthority(input: ToolExposureAuthorityInput = {}): ToolExposureAuthority {
  return createAuthorityToken(input);
}

/** Resolves only a token produced by {@link createToolExposureAuthority}. */
export function resolveToolExposureAuthority(value: unknown): ResolvedToolExposureAuthority | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return authorityRecords.get(value);
}

/**
 * Derives a fresh opaque authority for a delegated worker. Delegation may only
 * retain or remove parent capabilities; it can never turn a missing, null, or
 * forged parent token into positive authority.
 *
 * `childAllowedToolNames === undefined` means no additional child restriction.
 * An explicit empty list means zero tools. With no parent token and an explicit
 * child list, a private marker preserves those names only as candidates beneath
 * the runtime's existing non-local-read safe default. Null or forged parent
 * values never receive that marker and fail closed to zero authority.
 */
export function attenuateToolExposureAuthority(
  parentAuthority: unknown,
  childAllowedToolNames: readonly string[] | undefined
): ToolExposureAuthority | undefined {
  if (parentAuthority === undefined && childAllowedToolNames === undefined) {
    return undefined;
  }

  if (parentAuthority === undefined) {
    return childAllowedToolNames!.length === 0
      ? createToolExposureAuthority({ allowedToolNames: [], localMode: false })
      : createAuthorityToken({ allowedToolNames: childAllowedToolNames, localMode: false }, true);
  }

  const parent = resolveToolExposureAuthority(parentAuthority);
  if (!parent) {
    return createToolExposureAuthority({ allowedToolNames: [], localMode: false });
  }

  const childAllowed = childAllowedToolNames === undefined ? undefined : new Set(childAllowedToolNames);
  const allowedToolNames = childAllowed === undefined
    ? parent.allowedToolNames
    : parent.allowedToolNames.filter((toolName) => childAllowed.has(toolName));
  return createAuthorityToken({
    allowedToolNames,
    localMode: parent.localMode,
    ...(parent.profileId ? { profileId: parent.profileId } : {})
  }, parent.safeDefaultOnly === true);
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
