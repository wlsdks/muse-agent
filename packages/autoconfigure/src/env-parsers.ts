import { isRecord } from "@muse/shared";

/**
 * Pure environment-string parsers used across the autoconfigure
 * package. Lifted out of `index.ts` so internal modules
 * (`response-filters.ts`, `autoconfigure-model-provider.ts`) can
 * import them without a circular dependency on the runtime-assembly
 * factory. The four parsers that were previously exported from
 * `index.ts` are re-exported there, so external callers see no
 * surface change.
 *
 * Each parser takes `string | undefined` (the env-var shape) and a
 * fallback or default behavior. None throws — invalid input maps to
 * the fallback, so a typo'd MUSE_* var won't abort runtime boot.
 */

/**
 * Env-var boolean parsing, aligned with the
 * `RuntimeSettings.getBoolean` contract:
 *
 *   - whitespace-trimmed + lowercased
 *   - `"true" / "1" / "yes" / "on"` → `true`
 *   - `"false" / "0" / "no" / "off"` → `false`
 *   - anything else (typo, garbage, blank) → `fallback`
 *
 * Before this iteration, the parser only matched the truthy set
 * and silently returned `false` for anything else — so a typo'd
 * `MUSE_PROACTIVE_AGENT_TURN=Treu` produced `false` regardless of
 * the caller's fallback intent. The fallback-on-unknown branch
 * preserves the operator's stated default when the env value is
 * unrecognised, which is safer than the "unknown → false" coercion.
 */
const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);
const FALSY_ENV_VALUES: ReadonlySet<string> = new Set(["false", "0", "no", "off"]);

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalised = value.trim().toLowerCase();
  if (TRUTHY_ENV_VALUES.has(normalised)) return true;
  if (FALSY_ENV_VALUES.has(normalised)) return false;
  return fallback;
}

/**
 * Tri-state variant of `parseBoolean` for callers that need to
 * distinguish "explicit env value" from "value unset / unrecognised":
 *
 *   - one of the 8 standard spellings → `true | false`
 *   - undefined, blank, or unrecognised → `undefined`
 *
 * Used by setup-status's `readWebSearchEnvSnapshot` so the snapshot
 * can flip `source: "default" | "env"` on any recognised spelling,
 * not just literal "on" / "off".
 */
export function parseBooleanTriState(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  if (TRUTHY_ENV_VALUES.has(normalised)) return true;
  if (FALSY_ENV_VALUES.has(normalised)) return false;
  return undefined;
}

export function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  // `Number.parseInt` is lenient: it reads leading digits and
  // ignores trailing garbage, so a typo'd `MUSE_*=60x` silently
  // became 60 and `16k` became 16 (catastrophic for num_ctx).
  // The module contract is "invalid input → fallback", so require
  // the whole trimmed token to be a plain decimal integer.
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) {
    return fallback;
  }

  const parsed = Number(trimmed);
  // `Number.isInteger` returns true for values that lost precision
  // in the double-conversion (`"9007199254740993"` becomes 2^53
  // exactly, silently dropping the +1). `isSafeInteger` rejects
  // those so the operator's stated fallback wins instead of a
  // silently-wrong integer.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Like `parseInteger` but accepts a non-negative integer — i.e. honours an
 * explicit `0`. The float parsers distinguish `parsePositiveFloat` (> 0) from
 * `parseNonNegativeFloat` (>= 0); the integer side lacked the >= 0 variant, so
 * every caller used the > 0 `parseInteger`. That silently turned a deliberate
 * `MUSE_*=0` (disable / unlimited / no-budget) into the non-zero fallback — a
 * fail-open surprise (e.g. setting a per-day budget to 0 to disable it kept
 * the default). Use this for any setting where 0 is a meaningful value.
 */
export function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) {
    return fallback;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

// Same leniency hazard `parseInteger` was hardened against, for
// the float parsers: `Number.parseFloat("0.5x")` is `0.5` and
// `"60s"` is `60`, so a unit-slip / typo'd MUSE_* float silently
// took effect instead of the fallback. `Number` rejects trailing
// garbage (→ NaN) but still DECODES hex/octal/binary prefixes
// (`Number("0x10")===16`), so a typo'd `MUSE_*=0x1` silently became
// 1 — the same silent-coercion bug, just via a different notation.
// Gate on a decimal-float pattern (sign, optional fraction, optional
// exponent) so only base-10 floats pass; everything else maps to the
// fallback, matching `parseInteger`'s regex contract.
const DECIMAL_FLOAT_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
function strictFloat(value: string): number {
  const trimmed = value.trim();
  if (!DECIMAL_FLOAT_PATTERN.test(trimmed)) {
    return Number.NaN;
  }
  return Number(trimmed);
}

export function parseSloErrorRate(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : strictFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback;
  }
  return parsed;
}

export function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : strictFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function parseNonNegativeFloat(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : strictFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function parseCsv(value: string | undefined): readonly string[] | undefined {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries && entries.length > 0 ? entries : undefined;
}

export function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a JSON-object-string env var into a string-to-string header map,
 * e.g. `MUSE_MODEL_EXTRA_HEADERS='{"X-Gateway-Token":"abc123"}'` for a
 * self-hosted LAN LLM gateway (LiteLLM, a reverse proxy, Cloudflare-Access
 * service-token auth) that requires a header beyond the standard
 * `Authorization: Bearer <apiKey>`.
 *
 * Same fail-soft contract as every other parser here: undefined/blank,
 * invalid JSON, a non-object (array/primitive), or any non-string value
 * all map to `undefined` (no headers) rather than throwing — a malformed
 * value must never abort runtime boot. Rejects the WHOLE map on a single
 * bad entry rather than silently dropping it, so a typo doesn't quietly
 * lose the one header a self-hosted gateway actually requires to
 * authenticate.
 */
export function parseHeaderMap(value: string | undefined): Record<string, string> | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (key.trim().length === 0 || typeof raw !== "string") {
      return undefined;
    }
    out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
