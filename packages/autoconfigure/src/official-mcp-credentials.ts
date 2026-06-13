import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { OFFICIAL_MCP_PRESETS } from "@muse/mcp";

import { readCredentialsSync, stringField } from "./provider-utils.js";

import type { MuseEnvironment } from "./index.js";

/**
 * Secure credential resolution for the official-public MCP presets
 * (GitHub / Notion). Reuses the SAME two-tier seam the model-key and
 * messaging registries use — a dedicated env var (wins) or a
 * `~/.muse/mcp-credentials.json` file fallback read through
 * `readCredentialsSync`. The resolved token is forwarded ONLY as the
 * streamable transport's `Authorization: Bearer <token>` header; it is
 * never serialized into a logged/safe-config field and never invented.
 *
 * Both official remote servers authenticate header requests with a
 * Bearer token:
 *   - GitHub remote MCP — `Authorization: Bearer <PAT>`
 *     (docs.github.com/.../set-up-the-github-mcp-server, requestInit.headers)
 *   - Notion — `Authorization: Bearer <ntn_token>` (the documented
 *     header-auth for the streamable HTTP transport)
 *
 * Fail-closed: absent a resolvable credential this returns `undefined`
 * and the caller does NOT enable the preset — no blank-auth / broken
 * half-connection is ever produced.
 *
 * Credentials file shape (mirrors models.json / messaging.json):
 *   { "providers": { "github": { "token": "ghp_..." },
 *                     "notion": { "token": "ntn_..." },
 *                     "linear": { "token": "lin_api_..." } } }
 */

/**
 * The token env var for a preset auto-derives from its name —
 * `<NAME>_MCP_TOKEN` (GITHUB_MCP_TOKEN / NOTION_MCP_TOKEN /
 * LINEAR_MCP_TOKEN) — so a new curated preset gets its credential seam
 * for free, like the toggle and doctor posture. Derivation is gated on
 * the name being a CURATED preset so an arbitrary name never reads an
 * ambient env var.
 */
function presetEnvTokenKey(presetName: string): string | undefined {
  if (!Object.hasOwn(OFFICIAL_MCP_PRESETS, presetName)) {
    return undefined;
  }
  return `${presetName.toUpperCase()}_MCP_TOKEN`;
}

export function resolveOfficialMcpCredentialsFile(env: MuseEnvironment): string {
  const override = env.MUSE_MCP_CREDENTIALS_FILE?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return pathJoin(homedir(), ".muse", "mcp-credentials.json");
}

/**
 * Resolve the Bearer token for an official preset by name. Env var
 * (`<NAME>_MCP_TOKEN`, e.g. `GITHUB_MCP_TOKEN` / `NOTION_MCP_TOKEN` /
 * `LINEAR_MCP_TOKEN`) wins over the file; a whitespace-only value is
 * treated as absent. Returns `undefined` when no credential is
 * configured (the fail-closed signal).
 */
export function resolveOfficialMcpToken(env: MuseEnvironment, presetName: string): string | undefined {
  const envKey = presetEnvTokenKey(presetName);
  if (envKey) {
    const fromEnv = env[envKey]?.trim();
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv;
    }
  }
  const file = readCredentialsSync(resolveOfficialMcpCredentialsFile(env));
  return stringField(file[presetName], "token");
}

/**
 * Build the auth headers for an official preset, or `undefined` when no
 * credential is resolvable. The header value embeds the secret — keep
 * it OUT of any logged/serialized config.
 */
export function resolveOfficialMcpAuthHeaders(
  env: MuseEnvironment,
  presetName: string
): Record<string, string> | undefined {
  const token = resolveOfficialMcpToken(env, presetName);
  if (!token) {
    return undefined;
  }
  return { Authorization: `Bearer ${token}` };
}
