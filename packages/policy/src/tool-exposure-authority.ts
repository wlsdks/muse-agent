import { resolveCapabilityProfile } from "./capability-profile.js";
import { isAbsolute, normalize, sep } from "node:path";

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
  /** Canonical absolute write roots for a delegated run. Undefined means no additional path attenuation. */
  readonly writablePaths?: readonly string[];
  /** Canonical UTC expiry for delegated authority. */
  readonly expiresAt?: string;
  readonly localMode?: boolean;
  readonly profileId?: string;
}

export interface ResolvedToolExposureAuthority {
  readonly allowedToolNames: readonly string[];
  readonly writablePaths?: readonly string[];
  readonly expiresAt?: string;
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

function normalizeWritablePaths(paths: readonly string[] | undefined): {
  readonly paths?: readonly string[];
  readonly valid: boolean;
} {
  if (paths === undefined) return { valid: true };
  if (paths.some((path) =>
    typeof path !== "string"
    || path.length === 0
    || !isAbsolute(path)
    || normalize(path) !== path
    || path.includes("\0")
    || (sep === "/" ? path.includes("\\") : path.includes("/"))
  )) {
    return { paths: Object.freeze([]), valid: false };
  }
  return { paths: Object.freeze([...new Set(paths)]), valid: true };
}

function normalizedExpiry(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === expiresAt
    ? expiresAt
    : "1970-01-01T00:00:00.000Z";
}

function createAuthorityToken(
  input: ToolExposureAuthorityInput,
  safeDefaultOnly = false
): ToolExposureAuthority {
  const token = Object.freeze({}) as ToolExposureAuthority;
  const profileId = normalizedProfileId(input.profileId);
  const writableScope = normalizeWritablePaths(input.writablePaths);
  const writablePaths = writableScope.paths;
  const expiresAt = normalizedExpiry(input.expiresAt);
  const record = Object.freeze({
    allowedToolNames: writableScope.valid ? copyToolNames(input.allowedToolNames) : Object.freeze([]),
    localMode: input.localMode === true,
    ...(profileId ? { profileId } : {}),
    ...(writablePaths !== undefined ? { writablePaths } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
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
  const authority = authorityRecords.get(value);
  if (!authority) return undefined;
  if (authority.expiresAt !== undefined && Date.parse(authority.expiresAt) <= Date.now()) return undefined;
  return authority;
}

export interface DelegatedToolScope {
  readonly expiresAt: string;
  readonly writablePaths: readonly string[];
}

function pathWithin(path: string, root: string): boolean {
  const candidate = sep === "\\" ? path.toLowerCase() : path;
  const normalizedRoot = sep === "\\" ? root.toLowerCase() : root;
  const boundary = normalizedRoot.replace(/[\\/]+$/u, "");
  return candidate === boundary || candidate.startsWith(`${boundary}/`) || candidate.startsWith(`${boundary}\\`);
}

function intersectWritablePaths(
  parent: readonly string[] | undefined,
  child: readonly string[] | undefined
): readonly string[] | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  const intersection: string[] = [];
  for (const childPath of child) {
    for (const parentPath of parent) {
      if (pathWithin(childPath, parentPath)) intersection.push(childPath);
      else if (pathWithin(parentPath, childPath)) intersection.push(parentPath);
    }
  }
  return Object.freeze([...new Set(intersection)]);
}

function earliestExpiry(parent: string | undefined, child: string | undefined): string | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return parent <= child ? parent : child;
}

function normalizeDelegatedScope(scope: DelegatedToolScope): DelegatedToolScope | undefined {
  const writableScope = normalizeWritablePaths(scope.writablePaths);
  const expiresAt = normalizedExpiry(scope.expiresAt);
  if (!writableScope.valid || writableScope.paths === undefined || expiresAt !== scope.expiresAt) {
    return undefined;
  }
  return Object.freeze({ expiresAt, writablePaths: writableScope.paths });
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
  childAllowedToolNames: readonly string[] | undefined,
  childScope?: DelegatedToolScope
): ToolExposureAuthority | undefined {
  if (parentAuthority === undefined && childAllowedToolNames === undefined && childScope === undefined) {
    return undefined;
  }

  const normalizedChildScope = childScope ? normalizeDelegatedScope(childScope) : undefined;
  if (childScope && !normalizedChildScope) {
    return createToolExposureAuthority({ allowedToolNames: [], localMode: false });
  }

  if (parentAuthority === undefined) {
    const allowedToolNames = childAllowedToolNames ?? [];
    return allowedToolNames.length === 0
      ? createToolExposureAuthority({ allowedToolNames: [], localMode: false, ...normalizedChildScope })
      : createAuthorityToken({ allowedToolNames, localMode: false, ...normalizedChildScope }, true);
  }

  const parent = resolveToolExposureAuthority(parentAuthority);
  if (!parent) {
    return createToolExposureAuthority({ allowedToolNames: [], localMode: false });
  }

  const childAllowed = childAllowedToolNames === undefined ? undefined : new Set(childAllowedToolNames);
  const allowedToolNames = childAllowed === undefined
    ? parent.allowedToolNames
    : parent.allowedToolNames.filter((toolName) => childAllowed.has(toolName));
  const writablePaths = intersectWritablePaths(parent.writablePaths, normalizedChildScope?.writablePaths);
  const expiresAt = earliestExpiry(parent.expiresAt, normalizedChildScope?.expiresAt);
  return createAuthorityToken({
    allowedToolNames,
    localMode: parent.localMode,
    ...(parent.profileId ? { profileId: parent.profileId } : {}),
    ...(writablePaths !== undefined ? { writablePaths } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {})
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
