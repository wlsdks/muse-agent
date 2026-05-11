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
    const n = Number.parseInt(envRaw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof settings.maxUses === "number" && settings.maxUses > 0) {
    return settings.maxUses;
  }
  return DEFAULT_MAX_USES;
}
