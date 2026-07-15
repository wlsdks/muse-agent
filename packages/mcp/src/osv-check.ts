/**
 * Live OSV malware-advisory preflight for external MCP stdio servers.
 *
 * Complements the STATIC audit in `server-audit.ts` (pure, local,
 * fail-CLOSE) with a LIVE network check against OSV's malicious-package
 * feed (`MAL-*` advisory ids — deliberately NOT regular CVEs, which are
 * noise for a launch-time gate). Package registries host attacker-published
 * packages under innocuous-looking real names; a static launch-line scan
 * can't see that "npx some-malicious-pkg" is a KNOWN malware drop — only a
 * live registry query can.
 *
 * FAIL-OPEN BY DESIGN — the deliberate asymmetry with `server-audit.ts`:
 * this module makes a LIVE network call in the connect path. A static scan
 * is local, deterministic, and always available, so its failure to find a
 * problem safely means "no problem"; a live OSV query's failure (timeout,
 * DNS blip, 5xx, malformed body) means NOTHING about the package — treating
 * "OSV is unreachable" as "assume malware" would brick every local MCP
 * connection on a network hiccup, which is worse than the residual risk of
 * occasionally missing a check. A GENUINE `MAL-*` hit still fails CLOSED
 * (blocks the connect), matching the static audit's severity for a real
 * finding — only the "can't tell" case is treated differently.
 *
 * Pattern (NOT ported) converges with hermes `tools/osv_check.py`
 * (Apache-2.0) — Muse's variant is TypeScript-native with the house
 * `fetchImpl` injection pattern used elsewhere in the repo (see
 * `packages/calendar/src/google-provider.ts`, `packages/a2a/src/transport.ts`).
 */

import type { JsonObject } from "@muse/shared";

import { isRecord, type JsonObject } from "@muse/shared";

import type { McpServerAuditTarget } from "./server-audit.js";

export type OsvEcosystem = "npm" | "PyPI";

export interface MalwareAdvisory {
  readonly id: string;
  readonly summary?: string;
}

export interface MalwareAdvisoryResult {
  /** `true` when OSV was reached and reported no MAL-* advisory, OR when the check failed open. */
  readonly clean: boolean;
  readonly advisories: readonly MalwareAdvisory[];
  /** `true` only when a live OSV response was actually parsed — `false` on any fail-open path. */
  readonly checkedLive: boolean;
}

export interface CheckPackageForMalwareAdvisoryOptions {
  readonly fetchImpl?: typeof fetch;
  /** Bounded network timeout — a live check must never block MCP startup indefinitely. */
  readonly timeoutMs?: number;
  readonly endpoint?: string;
}

const OSV_ENDPOINT = "https://api.osv.dev/v1/query";
const OSV_TIMEOUT_MS = 12_000;

/**
 * Query the OSV API for `MAL-*` (malware) advisories on a specific
 * ecosystem package. Bounded by `timeoutMs` (default ~12s). Fails OPEN
 * (returns `clean: true`) on timeout, network error, non-2xx response, or a
 * malformed body — see the file header for why. Never throws.
 */
export async function checkPackageForMalwareAdvisory(
  ecosystem: OsvEcosystem,
  packageName: string,
  version?: string,
  options: CheckPackageForMalwareAdvisoryOptions = {}
): Promise<MalwareAdvisoryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? OSV_TIMEOUT_MS;
  const endpoint = options.endpoint ?? OSV_ENDPOINT;

  const payload: JsonObject = {
    package: { ecosystem, name: packageName },
    ...(version ? { version } : {})
  };

  try {
    const response = await fetchImpl(endpoint, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      return { advisories: [], checkedLive: false, clean: true };
    }

    const data: unknown = await response.json();
    const advisories = extractMalwareAdvisories(data);
    return { advisories, checkedLive: true, clean: advisories.length === 0 };
  } catch {
    // Timeout (AbortSignal.timeout fires → fetch rejects with an
    // AbortError), DNS/network failure, or a response body that isn't
    // valid JSON — all fail OPEN. This catch must never rethrow.
    return { advisories: [], checkedLive: false, clean: true };
  }
}

function extractMalwareAdvisories(data: unknown): readonly MalwareAdvisory[] {
  if (!isRecord(data) || !Array.isArray(data.vulns)) {
    return [];
  }

  const advisories: MalwareAdvisory[] = [];
  for (const entry of data.vulns) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!id.startsWith("MAL-")) continue;
    const summary = typeof entry.summary === "string" ? entry.summary : undefined;
    advisories.push({ id, ...(typeof summary === "string" ? { summary } : {}) });
  }
  return advisories;
}

export interface McpServerMalwareAuditResult {
  readonly safe: boolean;
  readonly reasons: readonly string[];
}

/**
 * Resolve the ecosystem package a stdio MCP server config is about to
 * launch (via `npx`/`uvx`/`pipx`) and check it against OSV's live
 * malware feed. Mirrors `auditMcpServerConfig`'s `{safe, reasons}` shape
 * so the two checks compose identically at the connect call site.
 *
 * Returns `safe: true` immediately (no network call) when the transport
 * isn't stdio, or the command isn't an ecosystem package runner Muse
 * recognizes — there is nothing to look up.
 */
export async function auditMcpServerPackageForMalware(
  target: McpServerAuditTarget,
  options: CheckPackageForMalwareAdvisoryOptions = {}
): Promise<McpServerMalwareAuditResult> {
  if (target.transportType !== "stdio") {
    return { safe: true, reasons: [] };
  }

  const resolved = resolveEcosystemPackage(target.config ?? {});
  if (!resolved) {
    return { safe: true, reasons: [] };
  }

  const result = await checkPackageForMalwareAdvisory(resolved.ecosystem, resolved.packageName, resolved.version, options);
  if (result.clean) {
    return { safe: true, reasons: [] };
  }

  const ids = result.advisories.map((advisory) => advisory.id).join(", ");
  return {
    reasons: [`OSV malware advisory (${ids}) for ${resolved.ecosystem} package "${resolved.packageName}"`],
    safe: false
  };
}

interface ResolvedEcosystemPackage {
  readonly ecosystem: OsvEcosystem;
  readonly packageName: string;
  readonly version?: string;
}

/**
 * Infer the package about to be spawned from a stdio launch config.
 * Only recognizes `npx`/`uvx`/`pipx` — the ecosystem package runners a
 * real MCP server config uses; anything else (bare `node`, `docker`,
 * a project-local binary) names no registry package to look up, so it
 * safely returns `undefined` (no live call, static audit already vets it).
 * Unwraps a single `env NAME=VALUE... CMD` wrapper first, matching
 * `server-audit.ts`'s unwrap so a hidden `npx` behind `env` still resolves.
 */
function resolveEcosystemPackage(config: JsonObject): ResolvedEcosystemPackage | undefined {
  const command = typeof config.command === "string" ? config.command : "";
  const args = readStringArray(config.args);
  const { command: effectiveCommand, args: effectiveArgs } = unwrapEnvWrapper(command, args);

  const ecosystem = inferEcosystem(basename(effectiveCommand));
  if (!ecosystem) return undefined;

  const token = firstPackageToken(effectiveArgs);
  if (!token) return undefined;

  return ecosystem === "npm" ? parseNpmPackage(token) : parsePyPiPackage(token);
}

function inferEcosystem(commandBase: string): OsvEcosystem | undefined {
  const base = commandBase.toLowerCase();
  if (base === "npx" || base === "npx.cmd") return "npm";
  if (base === "uvx" || base === "uvx.cmd" || base === "pipx" || base === "pipx.cmd") return "PyPI";
  return undefined;
}

/**
 * Find the package token in an argv list, skipping flags. Honors npx's
 * explicit install target (`--package NAME` / `--package=NAME` / `-p NAME`)
 * which names a package distinct from the executed binary; without this
 * the first bare positional (often a bin name, not the package) would be
 * mistaken for the package.
 */
function firstPackageToken(args: readonly string[]): string | undefined {
  let takeNext = false;
  for (const arg of args) {
    if (takeNext) return arg;
    if (arg === "--package" || arg === "-p") {
      takeNext = true;
      continue;
    }
    if (arg.startsWith("--package=")) return arg.slice("--package=".length);
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

// Scoped: @scope/name@version. Unscoped: name@version.
function parseNpmPackage(token: string): ResolvedEcosystemPackage {
  if (token.startsWith("@")) {
    const match = /^(@[^/]+\/[^@]+)(?:@(.+))?$/u.exec(token);
    if (match) {
      return { ecosystem: "npm", packageName: match[1]!, ...(match[2] ? { version: match[2] } : {}) };
    }
    return { ecosystem: "npm", packageName: token };
  }

  const at = token.lastIndexOf("@");
  if (at > 0) {
    const version = token.slice(at + 1);
    return { ecosystem: "npm", packageName: token.slice(0, at), ...(version && version !== "latest" ? { version } : {}) };
  }
  return { ecosystem: "npm", packageName: token };
}

// name==version or name[extras]==version.
function parsePyPiPackage(token: string): ResolvedEcosystemPackage {
  const match = /^([a-zA-Z0-9._-]+)(?:\[[^\]]*\])?(?:==(.+))?$/u.exec(token);
  if (match) {
    return { ecosystem: "PyPI", packageName: match[1]!, ...(match[2] ? { version: match[2] } : {}) };
  }
  return { ecosystem: "PyPI", packageName: token };
}

// Same env-unwrap contract as server-audit.ts's `unwrapEnvWrapper`
// (kept as a small local copy — this module intentionally has no
// dependency on server-audit.ts's internals, only its exported type).
function unwrapEnvWrapper(command: string, args: readonly string[]): { command: string; args: readonly string[] } {
  if (basename(command) !== "env") return { command, args };
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (arg === "-u" || arg === "-C" || arg === "-S" || arg === "-P") {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_]\w*=/u.test(arg)) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= args.length) return { command, args };
  return { args: args.slice(i + 1), command: args[i]! };
}

function basename(command: string): string {
  const norm = command.replace(/\\/gu, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
