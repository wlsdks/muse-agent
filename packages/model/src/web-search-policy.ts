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

export function decideWebSearchPolicy(args: DecideWebSearchPolicyArgs): WebSearchPolicy {
  const env = args.env ?? {};
  const settings = args.settings.webSearch ?? {};

  const envFlag = env.MUSE_WEB_SEARCH?.toLowerCase();
  if (envFlag === "off") {
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
  if (typeof settings.maxUses === "number" && settings.maxUses > 0) {
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
