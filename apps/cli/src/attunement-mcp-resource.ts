/**
 * External MCP resource adapters for Personal Continuity.
 *
 * A `resource` link points at an artifact on a CONNECTED MCP server (a GitHub
 * issue / PR today). Resolution is grounding-sensitive: the user names the exact
 * resource, an adapter maps it to a READ tool call, and the returned text is
 * UNTRUSTED — it is displayed as evidence but never elevated to a Muse-authored
 * fact, and a server that is unreachable / errors / returns nothing yields
 * `unavailable`, never a fabricated placeholder. GitHub is the first adapter;
 * `RESOURCE_ADAPTERS` is the single, replaceable seam a second server plugs into.
 */

import { AttunementStoreError, mcpProviderId, type ArtifactRole, type ResolvedArtifact } from "@muse/attunement";
import type { JsonObject } from "@muse/shared";

/**
 * Calls a READ tool on a connected MCP server. Injected so tests use a
 * contract-faithful fake and production threads the live McpManager. Returns
 * the raw (untrusted) tool result; throws when the server is unreachable / the
 * tool errors.
 */
export type McpToolCaller = (server: string, toolName: string, args: JsonObject) => Promise<unknown>;

interface ResourceReadPlan {
  readonly toolName: string;
  readonly args: JsonObject;
  /** The normalized, canonical resource id stored and re-resolved later. */
  readonly canonicalId: string;
}

interface ResourceServerAdapter {
  /** Parse a user-supplied resource id into a read plan; throw on a malformed id (fail-closed, no guess). */
  plan(resourceId: string): ResourceReadPlan;
  /**
   * Pull a display title (+ optional summary) out of the UNTRUSTED tool result.
   * Returns `undefined` when the result does not describe an existing resource
   * (treated as not-found → no link / unavailable).
   */
  extract(result: unknown): { readonly title: string; readonly summary?: string } | undefined;
}

const GITHUB_RESOURCE_PATTERN = /^(?<owner>[^/\s]+)\/(?<repo>[^/\s]+)\/(?<kind>issues|pull)\/(?<number>\d+)$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (typeof key === "string") output[key] = entryValue;
    }
    return output;
  }
  return undefined;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/**
 * GitHub official MCP mapping: `<owner>/<repo>/issues/<n>` → `get_issue`,
 * `<owner>/<repo>/pull/<n>` → `get_pull_request`. owner/repo are REQUIRED in the
 * id (never defaulted) so the resource is resolved, not guessed.
 */
const githubResourceAdapter: ResourceServerAdapter = {
  plan(resourceId) {
    const match = GITHUB_RESOURCE_PATTERN.exec(resourceId.trim());
    if (!match?.groups) {
      throw new AttunementStoreError(
        `github resource must be '<owner>/<repo>/issues/<n>' or '<owner>/<repo>/pull/<n>' (got '${resourceId}')`
      );
    }
    const { owner, repo, kind, number } = match.groups;
    const canonicalId = `${owner}/${repo}/${kind}/${number}`;
    if (kind === "issues") {
      return { toolName: "get_issue", args: { owner, repo, issue_number: Number(number) }, canonicalId };
    }
    return { toolName: "get_pull_request", args: { owner, repo, pullNumber: Number(number) }, canonicalId };
  },
  extract(result) {
    const record = asRecord(result);
    if (!record) return undefined;
    const title = firstString(record["title"]);
    if (!title) return undefined;
    const summary = firstString(record["body"], record["state"]);
    return summary ? { title, summary: summary.slice(0, 240) } : { title };
  }
};

/**
 * The curated resource-adapter registry, keyed by MCP server name. A second
 * server is added here with its own adapter; nothing else changes.
 */
const RESOURCE_ADAPTERS: Readonly<Record<string, ResourceServerAdapter>> = {
  github: githubResourceAdapter
};

export function resolveResourceAdapter(server: string): ResourceServerAdapter | undefined {
  return Object.hasOwn(RESOURCE_ADAPTERS, server) ? RESOURCE_ADAPTERS[server] : undefined;
}

/** Extract the server segment from an `mcp:<server>` provider id (fail-closed on any other shape). */
export function serverFromProviderId(providerId: string): string {
  if (!providerId.startsWith("mcp:")) {
    throw new AttunementStoreError(`resource provider must be 'mcp:<server>' (got '${providerId}')`);
  }
  return providerId.slice("mcp:".length);
}

/**
 * Confirm a resource exists on a named, connected MCP server and return its
 * canonical id + provider. Fail-closed: no caller (server not wired) ⇒ a clear
 * "connect the MCP server first"; malformed id / no adapter / read error /
 * not-found ⇒ throw, so NO link is created on a guess.
 */
export async function validateMcpResource(
  server: string,
  resourceId: string,
  caller: McpToolCaller | undefined
): Promise<{ readonly artifactId: string; readonly providerId: string }> {
  if (!caller) {
    throw new AttunementStoreError(
      `connect the MCP server '${server}' first — no MCP runtime is available to resolve this resource`
    );
  }
  const adapter = resolveResourceAdapter(server);
  if (!adapter) {
    throw new AttunementStoreError(`no resource adapter is registered for MCP server '${server}'`);
  }
  const plan = adapter.plan(resourceId);
  let result: unknown;
  try {
    result = await caller(server, plan.toolName, plan.args);
  } catch (cause) {
    if (cause instanceof AttunementStoreError) throw cause;
    throw new AttunementStoreError(
      `could not read resource '${resourceId}' from MCP server '${server}': ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const extracted = adapter.extract(result);
  if (!extracted) {
    throw new AttunementStoreError(`resource '${resourceId}' was not found on MCP server '${server}'`);
  }
  return { artifactId: plan.canonicalId, providerId: mcpProviderId(server) };
}

/**
 * Resolve a stored resource link at DISPLAY time into evidence. Any failure —
 * no caller, unknown server, a resource id that no longer canonicalizes, an
 * unreachable server, an erroring tool, an empty result — returns `undefined`
 * so the pack marks it `unavailable`; it NEVER fabricates a title or presents a
 * stale value as live.
 */
export async function resolveMcpResourceArtifact(
  server: string,
  resourceId: string,
  role: ArtifactRole,
  caller: McpToolCaller | undefined
): Promise<ResolvedArtifact | undefined> {
  if (!caller) return undefined;
  const adapter = resolveResourceAdapter(server);
  if (!adapter) return undefined;
  let plan: ResourceReadPlan;
  try {
    plan = adapter.plan(resourceId);
  } catch {
    return undefined;
  }
  if (plan.canonicalId !== resourceId) return undefined;
  let result: unknown;
  try {
    result = await caller(server, plan.toolName, plan.args);
  } catch {
    return undefined;
  }
  const extracted = adapter.extract(result);
  if (!extracted) return undefined;
  return {
    artifactId: plan.canonicalId,
    artifactType: "resource",
    providerId: mcpProviderId(server),
    role,
    title: extracted.title,
    ...(extracted.summary ? { summary: extracted.summary } : {})
  };
}
