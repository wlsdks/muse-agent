import type { MuseTool, ToolRisk } from "@muse/tools";

import type { McpServerInput } from "./index.js";

/**
 * Curated registry of OFFICIAL, publicly-documented external MCP
 * servers that anyone may connect to with their own credentials
 * (OAuth / personal access token). Each preset mirrors the Chrome
 * DevTools preset shape: a `createX()` factory returning an
 * `McpServerInput` wired for the streamable HTTP transport, plus a
 * fail-close risk classifier so the AgentRuntime's `toolApprovalGate`
 * gates any state-changing external action.
 *
 * Provenance (officially-public, anyone-may-connect):
 *   - GitHub official remote MCP — `https://api.githubcopilot.com/mcp/`
 *     (github/github-mcp-server, docs/remote-server.md; public preview
 *     announced 2025-06-12). Streamable HTTP, OAuth or PAT per user.
 *   - Notion hosted MCP — `https://mcp.notion.com/mcp`
 *     (developers.notion.com/guides/mcp/get-started-with-mcp). Streamable
 *     HTTP, OAuth per user.
 *   - Linear hosted MCP — `https://mcp.linear.app/mcp`
 *     (linear.app/docs/mcp). Streamable HTTP, OAuth 2.1 with dynamic
 *     client registration; the docs also document direct
 *     `Authorization: Bearer <token>` header auth with a personal API
 *     key, which is the seam these presets use. Any Linear account
 *     holder may connect their own workspace.
 *
 * SAFETY: reading is free, but every preset's WRITE-capable tool
 * (create issue / PR / page, comment) is classified `write` here so it
 * is fail-close + draft-first per `outbound-safety.md` — the external
 * server's own "read" annotation is NOT trusted. An UNKNOWN tool name
 * also defaults to `write` (fail-close), so a server that adds a new
 * mutating tool tomorrow is gated by default, never auto-sent.
 *
 * The credentials are user-supplied at config time (headers in
 * `~/.muse/mcp.json` or the OAuth flow the official server runs); these
 * presets ship NO secret and connect under the standard MCP security
 * policy once the server name is permitted by `allowedServerNames`
 * (empty = allow all).
 */
export interface OfficialMcpPreset {
  /** Stable MCP server name (matches `allowedServerNames`). */
  readonly name: string;
  /** Official, publicly-documented streamable HTTP endpoint. */
  readonly url: string;
  /** Official provenance URL proving anyone-may-connect status. */
  readonly provenanceUrl: string;
  /** Build the `McpServerInput` (optionally with auth headers). */
  readonly create: (options?: OfficialMcpPresetOptions) => McpServerInput;
  /** Fail-close risk for a bare tool name (read / write / execute). */
  readonly toolRisk: (toolName: string) => ToolRisk;
}

export interface OfficialMcpPresetOptions {
  /**
   * Auth headers forwarded to the streamable transport, e.g.
   * `{ Authorization: "Bearer ghp_..." }`. The preset ships none — the
   * user supplies their own credential. Omit for an OAuth-flow server.
   */
  readonly headers?: Record<string, string>;
  /** Connect at startup. Default `false` — opt-in. */
  readonly autoConnect?: boolean;
}

export const GITHUB_MCP_SERVER_NAME = "github";
export const NOTION_MCP_SERVER_NAME = "notion";
export const LINEAR_MCP_SERVER_NAME = "linear";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
const GITHUB_MCP_PROVENANCE =
  "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md";
const NOTION_MCP_URL = "https://mcp.notion.com/mcp";
const NOTION_MCP_PROVENANCE = "https://developers.notion.com/guides/mcp/get-started-with-mcp";
const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
const LINEAR_MCP_PROVENANCE = "https://linear.app/docs/mcp";

function buildStreamableInput(
  name: string,
  url: string,
  description: string,
  options: OfficialMcpPresetOptions
): McpServerInput {
  const headers = options.headers;
  return {
    autoConnect: options.autoConnect ?? false,
    config: {
      url,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {})
    },
    description,
    name,
    transportType: "streamable"
  };
}

// GitHub official MCP read surface (pure queries — safe, ungated). Any
// tool not listed here is fail-close `write`.
const GITHUB_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_me",
  "get_issue",
  "get_pull_request",
  "list_issues",
  "list_pull_requests",
  "list_commits",
  "get_file_contents",
  "search_code",
  "search_issues",
  "search_repositories",
  "list_branches"
]);

export function githubMcpToolRisk(toolName: string): ToolRisk {
  return GITHUB_READ_ONLY_TOOLS.has(toolName) ? "read" : "write";
}

export function createGitHubMcpServer(options: OfficialMcpPresetOptions = {}): McpServerInput {
  return buildStreamableInput(
    GITHUB_MCP_SERVER_NAME,
    GITHUB_MCP_URL,
    "Read GitHub issues / PRs / code via GitHub's official remote MCP server (writes stay draft-first)",
    options
  );
}

// Notion hosted MCP read surface. Any tool not listed here is
// fail-close `write`.
const NOTION_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "search",
  "fetch",
  "get-page",
  "get-database",
  "query-database",
  "list-users",
  "get-user",
  "get-self"
]);

export function notionMcpToolRisk(toolName: string): ToolRisk {
  return NOTION_READ_ONLY_TOOLS.has(toolName) ? "read" : "write";
}

export function createNotionMcpServer(options: OfficialMcpPresetOptions = {}): McpServerInput {
  return buildStreamableInput(
    NOTION_MCP_SERVER_NAME,
    NOTION_MCP_URL,
    "Read Notion pages / databases via Notion's official hosted MCP server (writes stay draft-first)",
    options
  );
}

// Linear hosted MCP read surface (the official server's list_* / get_* /
// search query tools — verified against linear.app/docs/mcp's documented
// tool set). Any tool not listed here — the create_*/update_* mutations
// and any future tool — is fail-close `write`.
const LINEAR_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "list_issues",
  "list_projects",
  "list_teams",
  "list_users",
  "list_documents",
  "list_cycles",
  "list_comments",
  "list_issue_labels",
  "list_issue_statuses",
  "list_project_labels",
  "get_issue",
  "get_project",
  "get_team",
  "get_user",
  "get_document",
  "get_issue_status",
  "search_documentation"
]);

export function linearMcpToolRisk(toolName: string): ToolRisk {
  return LINEAR_READ_ONLY_TOOLS.has(toolName) ? "read" : "write";
}

export function createLinearMcpServer(options: OfficialMcpPresetOptions = {}): McpServerInput {
  return buildStreamableInput(
    LINEAR_MCP_SERVER_NAME,
    LINEAR_MCP_URL,
    "Read Linear issues / projects / comments via Linear's official hosted MCP server (writes stay draft-first)",
    options
  );
}

/**
 * The curated set, keyed by server name. A new official-public server
 * is added here with its provenance URL; nothing else in the registry
 * needs to change.
 */
export const OFFICIAL_MCP_PRESETS: Readonly<Record<string, OfficialMcpPreset>> = {
  [GITHUB_MCP_SERVER_NAME]: {
    create: createGitHubMcpServer,
    name: GITHUB_MCP_SERVER_NAME,
    provenanceUrl: GITHUB_MCP_PROVENANCE,
    toolRisk: githubMcpToolRisk,
    url: GITHUB_MCP_URL
  },
  [NOTION_MCP_SERVER_NAME]: {
    create: createNotionMcpServer,
    name: NOTION_MCP_SERVER_NAME,
    provenanceUrl: NOTION_MCP_PROVENANCE,
    toolRisk: notionMcpToolRisk,
    url: NOTION_MCP_URL
  },
  [LINEAR_MCP_SERVER_NAME]: {
    create: createLinearMcpServer,
    name: LINEAR_MCP_SERVER_NAME,
    provenanceUrl: LINEAR_MCP_PROVENANCE,
    toolRisk: linearMcpToolRisk,
    url: LINEAR_MCP_URL
  }
};

/**
 * Look up an official preset by server name. Returns `undefined` for an
 * unknown / non-curated name — the caller must NOT synthesise a preset
 * for an arbitrary name (that would be the "unauthorized server" path
 * this registry exists to forbid).
 */
export function resolveOfficialMcpPreset(name: string): OfficialMcpPreset | undefined {
  return Object.hasOwn(OFFICIAL_MCP_PRESETS, name) ? OFFICIAL_MCP_PRESETS[name] : undefined;
}

/**
 * Re-stamp the risk + domain of an official-MCP-projected tool by its
 * server's fail-close classifier, so the AgentRuntime's approval gate
 * fires on a state-changing external action even though the external
 * server annotated the tool "read". Tools whose prefix matches no
 * curated preset pass through untouched.
 */
export function withOfficialMcpRisk(tools: readonly MuseTool[]): MuseTool[] {
  return tools.map((tool): MuseTool => {
    for (const preset of Object.values(OFFICIAL_MCP_PRESETS)) {
      const prefix = `${preset.name}.`;
      if (tool.definition.name.startsWith(prefix)) {
        const bare = tool.definition.name.slice(prefix.length);
        return {
          ...tool,
          definition: { ...tool.definition, domain: "external", risk: preset.toolRisk(bare) }
        };
      }
    }
    return tool;
  });
}
