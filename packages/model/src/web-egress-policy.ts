/**
 * Web-egress master switch — `MUSE_WEB_EGRESS`. This is the single
 * "airplane mode" for the public web: when off, every web-reaching tool
 * (web search, web page read, web download, web action) is removed from
 * the registry, fail-close, regardless of each tool's own enable flag.
 *
 * `MUSE_WEB_EGRESS` remains the explicit web-only kill switch. Under the
 * stricter `MUSE_LOCAL_ONLY=true` posture, however, Muse's interactive
 * public-web tools must also be unavailable. This module owns that trusted
 * environment-only composition; request metadata and model arguments never
 * participate in the decision.
 */

import { ENV_BOOLEAN_FALSE_VALUES, parseBooleanFromEnv } from "@muse/shared";
import { isLocalOnlyEnabled } from "./local-only-policy.js";

// Canonical falsy-spelling set shared with web-search-policy.ts so the two
// kill-switch parsers can never drift apart.
export const FALSY_BOOLEAN_VALUES: ReadonlySet<string> = ENV_BOOLEAN_FALSE_VALUES;

/**
 * True unless `MUSE_WEB_EGRESS` is an explicit falsy spelling
 * (`false`/`0`/`no`/`off`, case-insensitive, trimmed). Default-on: absence
 * means web tools stay available, preserving current behaviour.
 */
export function isWebEgressAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  return parseBooleanFromEnv(env["MUSE_WEB_EGRESS"], true);
}

/**
 * Trusted interactive-web posture used only at Muse-owned composition and CLI
 * boundaries. Local-only dominates a permissive `MUSE_WEB_EGRESS` value.
 */
export function isInteractiveWebEgressAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
  return isWebEgressAllowed(env) && !isLocalOnlyEnabled(env);
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
