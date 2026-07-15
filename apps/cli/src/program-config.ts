/**
 * Local CLI config store + API-target resolution, extracted from
 * `program-helpers.ts`:
 *
 *   - Config file I/O: `readConfigStore`, `writeConfigStore`,
 *     `setConfigValue`, `unsetConfigValue`, `configPath`,
 *     `defaultConfigPath`.
 *   - Resolving where/how a command talks to the API:
 *     `readApiOptions`, `ApiOptions`, `ReadApiOptionsOptions`.
 *   - CLI-option-vs-env precedence helpers shared by many
 *     subcommands: `firstNonEmpty`, `resolvePersona`.
 *   - Startup guards that don't belong to any of the above but are
 *     too small to warrant their own module: `isNodeError`,
 *     `ARGV_MAX_CHARS` / `assertArgvWithinLimit`.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Command } from "commander";

import { isRecord, readStoredToken } from "./credential-store.js";
import { closestCommandName } from "./closest-command.js";
import type { ProgramIO } from "./program.js";

export interface ApiOptions {
  readonly baseUrl: string;
  readonly token?: string;
}

export interface MuseCliConfig {
  readonly apiUrl?: string;
  readonly defaultModel?: string;
}

export interface ReadApiOptionsOptions {
  readonly includeStoredToken?: boolean;
}

/**
 * Guard against an oversized `process.argv` BEFORE the heavy dynamic
 * `import("./program.js")` runs. A single ~950k-char argv sits near V8's
 * synchronous stack ceiling and tips the ESM module-graph linking over
 * program.js's ~100-module graph into a raw `RangeError: Maximum call
 * stack size exceeded`. The threshold (800k) is safely below the observed
 * ~900k cliff, and this check itself pulls no heavy graph so it can't be
 * the thing that overflows. Returns the actionable one-line message when
 * over limit, or `null` when the argv is within bounds. Pure + exported
 * for unit tests.
 */
export const ARGV_MAX_CHARS = 800_000;

export function assertArgvWithinLimit(argv: readonly string[], maxChars = ARGV_MAX_CHARS): string | null {
  let total = 0;
  for (const arg of argv) {
    total += typeof arg === "string" ? arg.length : 0;
  }
  if (total <= maxChars) {
    return null;
  }
  return (
    `muse: input too large (${total.toString()} chars) — pass large content via stdin ` +
    "(e.g. `muse ask \"$(cat file)\"` → `cat file | muse ask`) instead of a command-line argument."
  );
}

export function defaultConfigPath(home?: string): string {
  const explicit = typeof home === "string" ? home.trim() : "";
  if (explicit.length > 0) return path.join(explicit, ".config", "muse", "config.json");
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return path.join(envHome, ".config", "muse", "config.json");
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return path.join(sysHome, ".config", "muse", "config.json");
  throw new Error("Cannot resolve home directory for config.json — HOME is empty and os.homedir() returned no value");
}

/**
 * Resolve a persona slot: explicit option > `MUSE_PERSONA` env > none.
 *
 * Centralises persona precedence so every subcommand (chat REPL,
 * brief, remember, ask, trust, approval, jobs) honours the same
 * env fallback. Setting `export MUSE_PERSONA=work` in a shell-rc
 * lets the user skip `--persona` on every invocation while keeping
 * the in-session `/persona` switch and explicit `--persona` flag
 * operational.
 */
export function resolvePersona(personaOption: string | undefined): string | undefined {
  const explicit = personaOption?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const fromEnv = process.env.MUSE_PERSONA?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export function configPath(io: ProgramIO): string {
  return io.configDir ? path.join(io.configDir, "config.json") : defaultConfigPath();
}

export function firstNonEmpty(...candidates: ReadonlyArray<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export async function readApiOptions(
  io: ProgramIO,
  command: Command,
  readOptions: ReadApiOptionsOptions = {}
): Promise<ApiOptions> {
  const globalOptions = command.optsWithGlobals<{ readonly apiUrl?: string; readonly token?: string }>();
  const config = await readConfigStore(io);
  const baseUrl = firstNonEmpty(globalOptions.apiUrl, process.env.MUSE_API_URL, config.apiUrl) ?? "http://127.0.0.1:3030";
  const explicitToken = firstNonEmpty(globalOptions.token, process.env.MUSE_API_TOKEN);

  return {
    baseUrl,
    token: explicitToken ?? (readOptions.includeStoredToken === false ? undefined : await readStoredToken(io, baseUrl))
  };
}

export async function readConfigStore(io: ProgramIO): Promise<MuseCliConfig> {
  const file = configPath(io);
  try {
    const raw = await readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `config file is not valid JSON: ${file} — fix or delete it (a fresh one is written on next \`muse setup\`)`
      );
    }

    if (!isRecord(parsed)) {
      throw new Error(`config file is not a JSON object: ${file} — fix or delete it`);
    }

    return {
      ...(typeof parsed.apiUrl === "string" && parsed.apiUrl.trim().length > 0 ? { apiUrl: parsed.apiUrl } : {}),
      ...(typeof parsed.defaultModel === "string" && parsed.defaultModel.trim().length > 0
        ? { defaultModel: parsed.defaultModel }
        : {})
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    if (isNodeError(error) && (error.code === "EISDIR" || error.code === "EACCES" || error.code === "EPERM")) {
      throw new Error(
        `config at ${file} is not a readable file (${error.code}) — remove or replace it (a fresh one is written on next \`muse setup\`)`,
        { cause: error }
      );
    }

    throw error;
  }
}

export async function writeConfigStore(io: ProgramIO, config: MuseCliConfig): Promise<void> {
  const filePath = configPath(io);
  await mkdir(path.dirname(filePath), { recursive: true });
  // Atomic tmp+rename (same pattern as credential-store / jwt-rotation-store):
  // a crash mid-write must never truncate the user's config.json to 0 bytes.
  const tmp = `${filePath}.tmp-${process.pid.toString()}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await chmod(filePath, 0o600).catch(() => undefined);
}

const SUPPORTED_CONFIG_KEYS = ["apiUrl", "defaultModel"] as const;

export function setConfigValue(config: MuseCliConfig, key: string, value: string): MuseCliConfig {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("Config value must not be empty");
  }

  if (key === "apiUrl") {
    return { ...config, apiUrl: trimmed };
  }

  if (key === "defaultModel") {
    return { ...config, defaultModel: trimmed };
  }

  const suggestion = closestCommandName(key, SUPPORTED_CONFIG_KEYS);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`Unsupported config key '${key}' (expected one of: ${SUPPORTED_CONFIG_KEYS.join(", ")})${hint}`);
}

/**
 * Clear a config key so it reverts to the built-in default (e.g. drop
 * a wrong `apiUrl` to fall back to the local server) — `set`'s missing
 * inverse, without hand-editing the JSON. Same key validation as
 * `setConfigValue`; `wasSet` lets the caller distinguish a real clear
 * from a no-op so it can say "x was not set" instead of a false
 * "cleared".
 */
export function unsetConfigValue(
  config: MuseCliConfig,
  key: string
): { readonly config: MuseCliConfig; readonly wasSet: boolean } {
  if (key !== "apiUrl" && key !== "defaultModel") {
    const suggestion = closestCommandName(key, SUPPORTED_CONFIG_KEYS);
    const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
    throw new Error(`Unsupported config key '${key}' (expected one of: ${SUPPORTED_CONFIG_KEYS.join(", ")})${hint}`);
  }
  const wasSet = config[key] !== undefined;
  const { [key]: _removed, ...rest } = config;
  return { config: rest, wasSet };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
