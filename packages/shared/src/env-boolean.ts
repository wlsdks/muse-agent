/**
 * Canonical env boolean parsing for all Muse packages.
 *
 * Keeps behavior in one place across modules that parse `MUSE_*` values:
 * - whitespace-trimmed + lowercased
 * - `true/1/yes/on` -> true
 * - `false/0/no/off` -> false
 * - undefined / blank / unknown -> configured fallback or undefined
 */

const TRUE_ENV_BOOLEAN_VALUES = ["true", "1", "yes", "on"] as const satisfies readonly string[];
const FALSE_ENV_BOOLEAN_VALUES = ["false", "0", "no", "off"] as const satisfies readonly string[];

/**
 * Canonical sets are exported for compatibility with legacy callers that still
 * rely on `.has(...)` checks.
 */
export const ENV_BOOLEAN_TRUE_VALUES: ReadonlySet<string> = new Set(TRUE_ENV_BOOLEAN_VALUES);
export const ENV_BOOLEAN_FALSE_VALUES: ReadonlySet<string> = new Set(FALSE_ENV_BOOLEAN_VALUES);

function normalizeEnvBoolean(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "" || normalized === undefined ? undefined : normalized;
}

function parseBooleanToken(normalized: string): boolean | undefined {
  if (ENV_BOOLEAN_TRUE_VALUES.has(normalized)) return true;
  if (ENV_BOOLEAN_FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

/**
 * Parse env text into boolean, defaulting to `fallback` for undefined/blank/unknown.
 */
export function parseBooleanFromEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = normalizeEnvBoolean(value);
  if (normalized === undefined) return fallback;
  return parseBooleanToken(normalized) ?? fallback;
}

/**
 * Parse env text into a tri-state boolean: undefined when unset/blank/unknown.
 */
export function parseBooleanTriStateFromEnv(value: string | undefined): boolean | undefined {
  const normalized = normalizeEnvBoolean(value);
  return normalized === undefined ? undefined : parseBooleanToken(normalized);
}
