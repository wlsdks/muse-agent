/**
 * Web-egress master switch — `MUSE_WEB_EGRESS`. This is the single
 * "airplane mode" for the public web: when off, every web-reaching tool
 * (web search, web page read, web download, web action) is removed from
 * the registry, fail-close, regardless of each tool's own enable flag.
 *
 * It is DELIBERATELY independent of `MUSE_LOCAL_ONLY`, which governs a
 * different egress class — your private data / prompts going to a CLOUD
 * LLM. `MUSE_LOCAL_ONLY` (on by default) keeps the model local; this
 * switch (on by default) controls whether the assistant may fetch a
 * *public* URL or run a *public* search. So a user can keep the local-LLM
 * privacy guarantee AND still search the web (the default), or set
 * `MUSE_WEB_EGRESS=false` for a true zero-outbound posture — the two are
 * orthogonal by design.
 */

// Canonical falsy-spelling set shared with web-search-policy.ts so the two
// kill-switch parsers can never drift apart.
export const FALSY_BOOLEAN_VALUES: ReadonlySet<string> = new Set(["false", "0", "no", "off"]);

/**
 * True unless `MUSE_WEB_EGRESS` is an explicit falsy spelling
 * (`false`/`0`/`no`/`off`, case-insensitive, trimmed). Default-on: absence
 * means web tools stay available, preserving current behaviour.
 */
export function isWebEgressAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env["MUSE_WEB_EGRESS"];
  if (raw === undefined) {
    return true;
  }
  return !FALSY_BOOLEAN_VALUES.has(raw.trim().toLowerCase());
}

export interface WebEgressPosture {
  readonly enabled: boolean;
  /** True only when the user explicitly turned egress off (vs the default-on). */
  readonly explicitlyDisabled: boolean;
}

/** Posture snapshot for `muse doctor` / setup-status. */
export function evaluateWebEgressPosture(env: Readonly<Record<string, string | undefined>>): WebEgressPosture {
  const enabled = isWebEgressAllowed(env);
  return { enabled, explicitlyDisabled: !enabled };
}
