/**
 * Canonical ambient source mode resolver shared across `api` and `cli` ambient
 * tick starters.
 *
 * Parsing contract:
 * - empty / unknown values default to `file` (fail-closed to local file source)
 * - `macos` is only accepted on darwin (to prevent silently creating OS-locked
 *   assumptions on non-Darwin hosts)
 * - `windows` is only accepted when explicitly enabled (used by CLI only)
 */

export type AmbientSourceMode = "file" | "macos" | "windows";

export interface AmbientSourceResolveOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsEnabled?: boolean;
}

function normalizeAmbientSource(value: string | undefined): string {
  return value === undefined ? "" : value.trim().toLowerCase();
}

export function resolveAmbientSourceMode(
  raw: string | undefined,
  options: AmbientSourceResolveOptions = {}
): AmbientSourceMode {
  const platform = options.platform ?? process.platform;
  const normalized = normalizeAmbientSource(raw);
  if (normalized === "macos" && platform === "darwin") {
    return "macos";
  }
  if (options.windowsEnabled === true && normalized === "windows" && platform === "win32") {
    return "windows";
  }
  return "file";
}
