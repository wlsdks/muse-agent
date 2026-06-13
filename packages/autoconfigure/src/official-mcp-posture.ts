import { OFFICIAL_MCP_PRESETS } from "@muse/mcp";

import { parseBoolean, parseCsv } from "./env-parsers.js";
import { resolveOfficialMcpToken } from "./official-mcp-credentials.js";

import type { MuseEnvironment } from "./index.js";

/**
 * Audit view of ONE official-public MCP preset (GitHub / Notion): is it
 * toggled on, does a credential resolve (boolean only — the secret is
 * NEVER read into this shape), is it permitted by the allowlist, and the
 * official provenance URL proving anyone-may-connect status. This is the
 * "tell it everything, it can't tell anyone" trust surface — a
 * privacy-first user can SEE exactly which external servers their agent
 * is eligible to reach and WHY (or why not).
 */
export interface OfficialMcpPresetPosture {
  readonly name: string;
  /** `MUSE_<NAME>_MCP_ENABLED` is truthy. */
  readonly enabled: boolean;
  /**
   * A Bearer credential resolves (env var or `~/.muse/mcp-credentials.json`).
   * BOOLEAN ONLY — the token value is never placed in this shape.
   */
  readonly credentialPresent: boolean;
  /** Permitted by `allowedServerNames` (empty/absent allowlist = allow-all). */
  readonly allowed: boolean;
  /** Official, publicly-documented provenance URL. */
  readonly provenanceUrl: string;
  /** Roll-up status mirroring the doctor's ok/warn convention. */
  readonly status: "ok" | "warn";
  /** Human-readable WHY (enabled but no credential, disabled, blocked, etc.). */
  readonly detail: string;
}

/**
 * Compute the audit posture for EVERY curated official-public preset from
 * the environment alone — pure, no I/O beyond the same credential
 * resolver the runtime uses (which only ever returns a boolean here, never
 * the token). Unit-testable without a full `muse doctor` run.
 *
 * The allowlist semantics MIRROR `assembleMcpStack`: an empty / absent
 * `MUSE_MCP_ALLOWED_SERVERS` means allow-all; a non-empty list is strict,
 * so a preset NOT in it is reported blocked even when enabled — surfacing
 * the silent "won't connect, and here's why" case.
 */
export function describeOfficialMcpPosture(env: MuseEnvironment): readonly OfficialMcpPresetPosture[] {
  const allowlist = parseCsv(env.MUSE_MCP_ALLOWED_SERVERS);
  const allowlistStrict = allowlist !== undefined && allowlist.length > 0;
  return Object.values(OFFICIAL_MCP_PRESETS).map((preset): OfficialMcpPresetPosture => {
    const enabled = parseBoolean(env[`MUSE_${preset.name.toUpperCase()}_MCP_ENABLED`], false);
    const credentialPresent = resolveOfficialMcpToken(env, preset.name) !== undefined;
    const allowed = allowlistStrict ? allowlist.includes(preset.name) : true;
    const { status, detail } = classifyPosture({ allowed, allowlistStrict, credentialPresent, enabled });
    return {
      allowed,
      credentialPresent,
      detail,
      enabled,
      name: preset.name,
      provenanceUrl: preset.provenanceUrl,
      status
    };
  });
}

function classifyPosture(input: {
  readonly enabled: boolean;
  readonly credentialPresent: boolean;
  readonly allowed: boolean;
  readonly allowlistStrict: boolean;
}): { readonly status: "ok" | "warn"; readonly detail: string } {
  if (!input.enabled) {
    return {
      detail: "disabled (default) — set the env toggle + provide a credential to connect",
      status: "ok"
    };
  }
  if (!input.credentialPresent) {
    return {
      detail: "enabled but NO credential resolves — it will not connect (set the token env var or ~/.muse/mcp-credentials.json)",
      status: "warn"
    };
  }
  if (!input.allowed) {
    return {
      detail: "enabled + credential present, but BLOCKED by the MUSE_MCP_ALLOWED_SERVERS allowlist — add it to connect",
      status: "warn"
    };
  }
  return { detail: "enabled, credential present, allowed — eligible to connect", status: "ok" };
}
