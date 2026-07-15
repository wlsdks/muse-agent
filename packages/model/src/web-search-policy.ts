import { isRecord, parseBooleanTriStateFromEnv } from "@muse/shared";

export interface WebSearchPolicy {
  readonly enabled: boolean;
  readonly maxUses: number;
}

export interface WebSearchSettings {
  readonly enabled?: boolean;
  readonly maxUses?: number;
}

export interface DecideWebSearchPolicyArgs {
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly settings: { readonly webSearch?: WebSearchSettings };
  readonly override?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_MAX_USES = 5;
const DEFAULT_WEB_SEARCH_POLICY: WebSearchPolicy = { enabled: false, maxUses: DEFAULT_MAX_USES };

export function readWebSearchPolicy(value: unknown): WebSearchPolicy {
  if (!isRecord(value)) {
    return DEFAULT_WEB_SEARCH_POLICY;
  }
  const enabled = value.enabled;
  const maxUsesRaw = value.maxUses;
  const maxUses = typeof maxUsesRaw === "number" && Number.isInteger(maxUsesRaw) && maxUsesRaw > 0
    ? maxUsesRaw
    : DEFAULT_MAX_USES;
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_WEB_SEARCH_POLICY.enabled,
    maxUses
  };
}

export function decideWebSearchPolicy(args: DecideWebSearchPolicyArgs): WebSearchPolicy {
  const env = args.env ?? {};
  const settings = args.settings.webSearch ?? {};

  // Any standard falsy spelling (false / 0 / no / off, case-
  // insensitive, trimmed) is a hard kill switch — overrides
  // `args.override === true` so an operator-set MUSE_WEB_SEARCH=false
  // cannot be re-enabled by a per-call override. Truthy spellings
  // are intentionally NOT a force-enable: that would clash with
  // `args.override === false` and is unnecessary since the default
  // is already enabled.
  if (parseBooleanTriStateFromEnv(env.MUSE_WEB_SEARCH) === false) {
    return { enabled: false, maxUses: resolveMaxUses(env, settings) };
  }

  if (args.override === true) {
    return { enabled: true, maxUses: resolveMaxUses(env, settings) };
  }
  if (args.override === false) {
    return { enabled: false, maxUses: resolveMaxUses(env, settings) };
  }

  const enabled = settings.enabled !== false;
  return { enabled, maxUses: resolveMaxUses(env, settings) };
}

function resolveMaxUses(
  env: Readonly<Record<string, string | undefined>>,
  settings: WebSearchSettings
): number {
  const envRaw = env.MUSE_WEB_SEARCH_MAX_USES;
  if (envRaw !== undefined) {
    const n = strictPositiveInt(envRaw);
    if (n !== undefined) return n;
  }
  // Match the env path's strictness: a settings `maxUses` of
  // Infinity (unbounded search budget) or a non-integer (3.5)
  // would otherwise slip past a bare `> 0` check, where the env
  // path rejects the same shapes via strictPositiveInt.
  if (typeof settings.maxUses === "number" && Number.isInteger(settings.maxUses) && settings.maxUses > 0) {
    return settings.maxUses;
  }
  return DEFAULT_MAX_USES;
}

// Number.parseInt is lenient: a typo'd "3x" or unit-slip "30s"
// silently became 3 / 30, disagreeing with what `muse doctor`
// reports as an invalid env value. Require the whole trimmed
// token to be a plain positive integer instead.
function strictPositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
