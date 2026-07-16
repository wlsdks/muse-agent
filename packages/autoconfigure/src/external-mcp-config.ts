import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { errorMessage, type JsonObject } from "@muse/shared";
import type { McpServerInput, McpServerStore, McpTransportType } from "@muse/mcp";

import { ConfigurationError, type MuseEnvironment } from "./index.js";

/**
 * Claude-Desktop-style external MCP server config loader.
 *
 * Reads `~/.muse/mcp.json` (or `MUSE_MCP_CONFIG` if set) and returns
 * a list of `McpServerInput` rows the runtime assembly seeds into the
 * `McpServerStore` at startup. Mirrors the `claude_desktop_config.json`
 * shape so users can copy-paste their existing entries.
 *
 * Schema:
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
 *         "env": { "FOO": "bar" }
 *       },
 *       "github": {
 *         "transport": "streamable",
 *         "url": "https://api.githubcopilot.com/mcp/",
 *         "headers": { "Authorization": "Bearer ghp_..." }
 *       },
 *       "experiment": {
 *         "command": "node",
 *         "args": ["./local-server.js"],
 *         "disabled": true
 *       }
 *     }
 *   }
 *
 * Transport inference:
 *   - `command` present → stdio (any explicit `transport` is ignored).
 *   - `url` present → `transport` value if given (`streamable` | `sse`),
 *     defaults to `streamable`.
 *   - Neither → ConfigurationError.
 *
 * Disabled entries (top-level `disabled: true`) are skipped silently —
 * no row is emitted, but the entry can be flipped on without rewriting
 * the file. They still reserve their normalized server name, so a disabled
 * `" filesystem "` cannot silently shadow an active `"filesystem"` entry.
 *
 * Missing file → empty list (not an error). Malformed JSON or invalid
 * entry shape → ConfigurationError so misconfigurations surface loudly.
 */
export function resolveExternalMcpConfigFile(env: MuseEnvironment): string {
  const override = env.MUSE_MCP_CONFIG?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return pathJoin(homedir(), ".muse", "mcp.json");
}

export function loadExternalMcpConfig(env: MuseEnvironment): readonly McpServerInput[] {
  const path = resolveExternalMcpConfigFile(env);
  const raw = tryReadFile(path);
  if (raw === undefined) {
    return [];
  }
  return parseExternalMcpConfig(raw, path);
}

export function parseExternalMcpConfig(raw: string, source = "<inline>"): readonly McpServerInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigurationError(
      `Invalid JSON in MCP config (${source}): ${errorMessage(cause)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigurationError(`MCP config (${source}) must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers === undefined || servers === null) {
    return [];
  }
  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw new ConfigurationError(`MCP config (${source}).mcpServers must be a JSON object`);
  }
  const entries = Object.entries(servers as Record<string, unknown>);
  const out: McpServerInput[] = [];
  const names = new Set<string>();
  for (const [name, value] of entries) {
    const trimmedName = name.trim();
    const nameError = serverNameError(trimmedName);
    if (nameError) {
      throw new ConfigurationError(`MCP config (${source}) has ${nameError}`);
    }
    if (names.has(trimmedName)) {
      throw new ConfigurationError(`MCP config (${source}) has duplicate server name after trimming: ${JSON.stringify(trimmedName)}`);
    }
    names.add(trimmedName);
    const entry = parseEntry(trimmedName, value, source);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

function parseEntry(name: string, value: unknown, source: string): McpServerInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`MCP config (${source}).mcpServers.${name} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
    throw new ConfigurationError(`MCP config (${source}).mcpServers.${name}.disabled must be a boolean`);
  }
  if (entry.disabled === true) {
    return undefined;
  }
  const description = stringOrUndefined(entry.description);
  const autoConnectRaw = entry.autoConnect;
  if (autoConnectRaw !== undefined && typeof autoConnectRaw !== "boolean") {
    throw new ConfigurationError(`MCP config (${source}).mcpServers.${name}.autoConnect must be a boolean`);
  }
  const autoConnect = autoConnectRaw ?? true;
  const transport = inferTransport(name, entry, source);
  const config = buildConfig(name, entry, transport, source);
  return {
    autoConnect,
    config,
    name,
    transportType: transport,
    ...(description !== undefined ? { description } : {})
  };
}

function inferTransport(name: string, entry: Record<string, unknown>, source: string): McpTransportType {
  if (typeof entry.command === "string") {
    return "stdio";
  }
  if (typeof entry.url === "string") {
    const explicit = stringOrUndefined(entry.transport);
    if (explicit === undefined) {
      return "streamable";
    }
    if (explicit === "streamable" || explicit === "sse") {
      return explicit;
    }
    throw new ConfigurationError(
      `MCP config (${source}).mcpServers.${name}.transport must be 'streamable' or 'sse' (got ${JSON.stringify(explicit)})`
    );
  }
  throw new ConfigurationError(
    `MCP config (${source}).mcpServers.${name} requires either a 'command' (stdio) or a 'url' (streamable/sse)`
  );
}

function buildConfig(
  name: string,
  entry: Record<string, unknown>,
  transport: McpTransportType,
  source: string
): JsonObject {
  if (transport === "stdio") {
    const command = entry.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new ConfigurationError(`MCP config (${source}).mcpServers.${name}.command must be a non-empty string`);
    }
    const args = parseStringArray(entry.args, `mcpServers.${name}.args`, source);
    const cwd = stringOrUndefined(entry.cwd);
    const env = parseStringMap(entry.env, `mcpServers.${name}.env`, source);
    return {
      command,
      ...(args ? { args } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env ? { env } : {})
    };
  }
  const url = entry.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new ConfigurationError(`MCP config (${source}).mcpServers.${name}.url must be a non-empty string`);
  }
  const urlFinding = remoteUrlFinding(url);
  if (urlFinding) {
    throw new ConfigurationError(`MCP config (${source}).mcpServers.${name}.${urlFinding}`);
  }
  const headers = parseStringMap(entry.headers, `mcpServers.${name}.headers`, source);
  return {
    url,
    ...(headers ? { headers } : {})
  };
}

function parseStringArray(value: unknown, label: string, source: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigurationError(`MCP config (${source}).${label} must be a string array`);
  }
  return [...(value as readonly string[])];
}

function parseStringMap(value: unknown, label: string, source: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`MCP config (${source}).${label} must be a string-to-string object`);
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") {
      throw new ConfigurationError(`MCP config (${source}).${label}.${key} must be a string`);
    }
    out[key] = raw;
  }
  return out;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type ExternalMcpEntryStatus = "ok" | "skipped" | "error";

export interface ExternalMcpEntryDiagnosis {
  readonly name: string;
  readonly status: ExternalMcpEntryStatus;
  readonly transportType?: McpTransportType;
  readonly findings: readonly string[];
  readonly entry?: McpServerInput;
}

/**
 * Per-entry validation that collects all errors instead of bailing
 * on the first malformed entry. The `parseExternalMcpConfig` parser
 * throws on the first invalid entry it sees — useful at runtime
 * (loud failure) but unhelpful for the doctor flow where the user
 * wants to see every problem at once.
 *
 * Returns `ok` (fully valid + would be loaded), `skipped`
 * (valid + `disabled: true`, intentionally not loaded), or `error`
 * (would have thrown if parsed live, with the original error
 * message in `findings`).
 *
 * Outer JSON parse errors still throw `ConfigurationError` — they
 * affect every entry equally, so per-entry collection makes no
 * sense there.
 */
export function diagnoseExternalMcpConfig(
  raw: string,
  source = "<inline>"
): readonly ExternalMcpEntryDiagnosis[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigurationError(
      `Invalid JSON in MCP config (${source}): ${errorMessage(cause)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigurationError(`MCP config (${source}) must be a JSON object`);
  }
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers === undefined || servers === null) {
    return [];
  }
  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw new ConfigurationError(`MCP config (${source}).mcpServers must be a JSON object`);
  }
  const out: ExternalMcpEntryDiagnosis[] = [];
  const normalizedNameCounts = new Map<string, number>();
  for (const rawName of Object.keys(servers as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!serverNameError(name)) {
      normalizedNameCounts.set(name, (normalizedNameCounts.get(name) ?? 0) + 1);
    }
  }
  for (const [rawName, value] of Object.entries(servers as Record<string, unknown>)) {
    const trimmedName = rawName.trim();
    const nameError = serverNameError(trimmedName);
    if (nameError) {
      out.push({ findings: [nameError], name: rawName, status: "error" });
      continue;
    }
    if ((normalizedNameCounts.get(trimmedName) ?? 0) > 1) {
      out.push({
        findings: [`duplicate server name after trimming: ${JSON.stringify(trimmedName)}`],
        name: rawName,
        status: "error"
      });
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).disabled === true) {
      out.push({ findings: ["disabled: true — entry will not be loaded at boot"], name: trimmedName, status: "skipped" });
      continue;
    }
    try {
      const entry = parseEntry(trimmedName, value, source);
      if (entry) {
        const findings = validateEntry(entry);
        out.push({
          entry,
          findings,
          name: trimmedName,
          status: findings.length === 0 ? "ok" : "error",
          transportType: entry.transportType
        });
      }
    } catch (cause) {
      out.push({
        findings: [errorMessage(cause)],
        name: trimmedName,
        status: "error"
      });
    }
  }
  return out;
}

/**
 * Run `diagnoseExternalMcpConfig` against the resolved external
 * MCP config file. Returns an empty array when the file is missing
 * (same as `loadExternalMcpConfig`) so doctor flows distinguish
 * "not configured" from "configured but broken".
 */
export function diagnoseExternalMcpConfigFile(
  env: MuseEnvironment
): readonly ExternalMcpEntryDiagnosis[] {
  const path = resolveExternalMcpConfigFile(env);
  const raw = tryReadFile(path);
  if (raw === undefined) {
    return [];
  }
  return diagnoseExternalMcpConfig(raw, path);
}

function validateEntry(entry: McpServerInput): readonly string[] {
  const findings: string[] = [];
  if (entry.transportType === "streamable" || entry.transportType === "sse") {
    const url = (entry.config as { url?: unknown } | undefined)?.url;
    if (typeof url === "string") {
      const finding = remoteUrlFinding(url);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

function remoteUrlFinding(url: string): string | undefined {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:"
      ? undefined
      : `url protocol is '${parsedUrl.protocol}', expected http: or https:`;
  } catch {
    return `url is not a valid URL: ${JSON.stringify(url)}`;
  }
}

/**
 * Seed parsed external entries into a `McpServerStore`. Existing
 * entries (looked up by name) are left untouched so manually-edited
 * DB rows or already-registered servers are never clobbered. Returns
 * the names that were freshly inserted so the caller can log them.
 *
 * Safe to call on either `InMemoryMcpServerStore` (sync) or
 * `KyselyMcpServerStore` (async) — the Awaitable contract handles
 * both.
 */
export async function seedExternalMcpServers(
  store: McpServerStore,
  entries: readonly McpServerInput[]
): Promise<readonly string[]> {
  const inserted: string[] = [];
  for (const entry of entries) {
    const existing = await store.findByName(entry.name);
    if (existing) {
      continue;
    }
    await store.save(entry);
    inserted.push(entry.name);
  }
  return inserted;
}

function tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ConfigurationError(
      `Failed to read MCP config at ${path}: ${errorMessage(cause)}`
    );
  }
}

function serverNameError(name: string): string | undefined {
  if (name.length === 0) {
    return "an empty server name";
  }
  if (/[\u0000-\u001F\u007F]/u.test(name)) {
    return "a server name containing control characters";
  }
  return undefined;
}
