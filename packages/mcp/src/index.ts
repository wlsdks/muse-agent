import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JsonObject, JsonValue } from "@muse/shared";
import type { ToolRisk } from "@muse/tools";

import type { McpSecurityPolicyProvider } from "./in-memory-stores.js";
import type { CheckPackageForMalwareAdvisoryOptions } from "./osv-check.js";

export type Awaitable<T> = T | Promise<T>;
export type McpTransportType = "stdio" | "sse" | "streamable" | "http";
export type McpServerStatus = "pending" | "connecting" | "connected" | "disconnected" | "failed" | "disabled";
export type McpHealthStatus = "unknown" | "healthy" | "unhealthy";

export interface McpServer {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly transportType: McpTransportType;
  readonly config: JsonObject;
  readonly version?: string;
  readonly autoConnect: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface McpServerInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly transportType: McpTransportType;
  readonly config?: JsonObject;
  readonly version?: string | null;
  readonly autoConnect?: boolean;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface McpServerStore {
  list(): Awaitable<readonly McpServer[]>;
  findByName(name: string): Awaitable<McpServer | undefined>;
  save(input: McpServerInput): Awaitable<McpServer>;
  update(name: string, input: McpServerInput): Awaitable<McpServer | undefined>;
  delete(name: string): Awaitable<void>;
}

export interface McpSecurityPolicy {
  readonly allowedServerNames: readonly string[];
  readonly maxToolOutputLength: number;
  readonly allowedStdioCommands: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface McpSecurityPolicyInput {
  readonly allowedServerNames?: readonly string[];
  readonly maxToolOutputLength?: number;
  readonly allowedStdioCommands?: readonly string[];
}

export interface McpSecurityPolicyStore {
  getOrNull(): Awaitable<McpSecurityPolicy | undefined>;
  save(input: McpSecurityPolicyInput): Awaitable<McpSecurityPolicy>;
  delete(): Awaitable<boolean>;
}

export interface McpRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonObject;
  readonly risk?: ToolRisk;
  /**
   * Context Engineering Phase 4 hint. When set, `createMcpMuseTool`
   * forwards this to `MuseToolDefinition.domain` so DefaultToolFilter
   * skips the name-prefix heuristic. Loopback servers tag their tools
   * explicitly; external MCP servers usually don't supply this and
   * fall back to the heuristic as before.
   */
  readonly domain?: string;
  /**
   * Relevance keywords forwarded to `MuseToolDefinition.keywords` so
   * DefaultToolFilter surfaces this specific tool when the prompt
   * mentions one of them — letting a loopback tool be selectable for
   * vocabulary its domain heuristic misses (e.g. availability for "am
   * I free?"). Per-tool, so a generic word only exposes THIS tool, not
   * the whole domain.
   */
  readonly keywords?: readonly string[];
  /**
   * Free-text argument names that must be GROUNDED in the user's utterance,
   * forwarded to `MuseToolDefinition.groundedArgs`. The runtime drops any such
   * arg the model fabricated (an 8B invents a calendar `location`/`notes` the
   * user never said). Loopback actuator tools set this; external MCP tools
   * usually don't.
   */
  readonly groundedArgs?: readonly string[];
}

export interface McpConnection {
  listTools(): Awaitable<readonly McpRemoteTool[]>;
  callTool?(toolName: string, args: JsonObject): Awaitable<string | JsonValue>;
  close?(): Awaitable<void>;
  /**
   * Live transport health. `false` means the underlying transport has
   * closed or errored (e.g. a stdio child process died) — the SDK
   * client's `onclose`/`onerror` flipped it. `undefined`/absent means
   * the connection type doesn't report liveness (loopback in-process
   * connections never die this way), so it is treated as alive. The
   * manager uses this to retire + rebuild a dead cached connection
   * instead of calling into it and getting the SDK's generic
   * "Not connected".
   */
  readonly connected?: boolean;
  /** Why the transport went down, surfaced in the compound reconnect error. */
  readonly disconnectReason?: string;
}

/**
 * Result of re-resolving the CURRENT live connection for a server at
 * tool-invocation time. `createMcpMuseTool`'s execute path asks for this
 * on every call instead of closing over one connection object captured at
 * build time — so a retire+reconnect (a crashed stdio server self-healing
 * on the next turn) is transparent to the already-built tool, and a
 * permanent failure surfaces a clear `error` rather than the SDK's generic
 * "Not connected".
 */
export type McpConnectionResolution =
  | { readonly connection: McpConnection; readonly error?: undefined }
  | { readonly connection?: undefined; readonly error: string };

export interface McpTransportConnector {
  connect(server: McpServer, policy: McpSecurityPolicy): Promise<McpConnection>;
}

export interface DefaultMcpTransportConnectorOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly allowPrivateAddresses?: boolean;
  readonly stderr?: StdioServerParameters["stderr"];
  /**
   * Filesystem paths exposed to MCP servers via the `roots/list`
   * request. When provided, the client advertises the `roots`
   * capability and answers server-issued `roots/list` calls with
   * these paths as `file://` URIs. When undefined or empty, the
   * client still advertises the capability (so spec-compliant MCP
   * servers stop logging `Client does not support MCP Roots`
   * warnings and fall back to argv-based directories) but returns
   * an empty roots list.
   *
   * Personal-JARVIS default: empty. The user opts in via
   * `MUSE_MCP_CLIENT_ROOTS` (comma-separated absolute paths) when
   * a specific external MCP server (filesystem, search, etc.)
   * needs broader directory access than its launch args allow.
   */
  readonly clientRoots?: readonly string[];
}

export interface McpServerValidationOptions {
  readonly allowPrivateAddresses?: boolean;
}

export interface McpManagerOptions {
  readonly connector?: McpTransportConnector;
  readonly reconnect?: Partial<McpReconnectPolicy>;
  readonly securityPolicyProvider?: McpSecurityPolicyProvider;
  readonly store?: McpServerStore;
  readonly validation?: McpServerValidationOptions;
  readonly now?: () => Date;
  /**
   * Live OSV malware-advisory preflight (`osv-check.ts`), additional to
   * the static `server-audit.ts` scan. Opt-in and unset by default —
   * mirrors the fingerprint-pinning posture (`verifyServerFingerprint`:
   * "missing pin = no enforcement"), for the same reason: a network
   * dependency should never turn on for every deployment/test unasked.
   * Pass `{}` (or explicit `fetchImpl`/`timeoutMs`/`endpoint`) to enable
   * the live check at `connect()`.
   */
  readonly osvMalwareCheck?: CheckPackageForMalwareAdvisoryOptions;
}

export interface McpReconnectPolicy {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface McpHealthSnapshot {
  readonly serverName: string;
  readonly status: McpHealthStatus;
  readonly checkedAt?: Date;
  readonly error?: string;
  readonly reconnectAttempts: number;
  readonly nextReconnectAt?: Date;
  readonly toolCount: number;
}

export type McpPreflightCheckStatus = "pass" | "warn" | "fail";

export interface McpPreflightCheck {
  readonly code: string;
  readonly message: string;
  readonly status: McpPreflightCheckStatus;
}

export interface McpPreflightReport {
  readonly checks: readonly McpPreflightCheck[];
  readonly health: McpHealthSnapshot;
  readonly ok: boolean;
  readonly readyForProduction: boolean;
  readonly serverName: string;
  readonly status: McpServerStatus;
  readonly summary: {
    readonly failCount: number;
    readonly passCount: number;
    readonly warnCount: number;
  };
}

export interface InMemoryMcpServerStoreOptions {
  readonly idFactory?: () => string;
  readonly maxServers?: number;
  readonly now?: () => Date;
}

export interface InMemoryMcpSecurityPolicyStoreOptions {
  readonly initial?: McpSecurityPolicyInput;
  readonly now?: () => Date;
}

export interface KyselyMcpServerStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface KyselyMcpSecurityPolicyStoreOptions {
  readonly now?: () => Date;
}

// In-memory stores + normalizers + error classes live in
// `./in-memory-stores.ts`. Kysely-backed stores live in
// `./server-stores.ts`. Re-export both so external call-sites
// stay byte-identical.
export {
  InMemoryMcpServerStore,
  InMemoryMcpSecurityPolicyStore,
  McpSecurityPolicyProvider,
  McpRegistryError,
  McpConnectionError,
  isRetryableMcpConnectStatus,
  normalizeMcpServerInput,
  normalizeMcpSecurityPolicy,
  normalizeReconnectPolicy
} from "./in-memory-stores.js";

// McpManager runtime registry lives in `./manager.ts`.
export { McpManager } from "./manager.js";

// Transport connector + SDK connection adapter live in `./transport.ts`.
export { DefaultMcpTransportConnector } from "./transport.js";

// Kysely-backed persistence lives in `./server-stores.ts`.
export { KyselyMcpSecurityPolicyStore, KyselyMcpServerStore } from "./server-stores.js";

export {
  isPrivateOrReservedHost,
  isPublicHttpUrl,
  validateMcpServer,
  validateStdioArgs,
  validateStdioCommand
} from "./validators.js";

export {
  auditMcpServerConfig,
  type McpServerAuditResult,
  type McpServerAuditTarget
} from "./server-audit.js";

export {
  auditMcpServerPackageForMalware,
  checkPackageForMalwareAdvisory,
  type CheckPackageForMalwareAdvisoryOptions,
  type MalwareAdvisory,
  type MalwareAdvisoryResult,
  type McpServerMalwareAuditResult,
  type OsvEcosystem
} from "./osv-check.js";

// createMcpMuseTool (+ its redactMcpSecrets helper, exported for direct
// unit-test coverage) lives in `./mcp-tool-factory.ts`. Re-exported so
// external call-sites stay byte-identical.
export { createMcpMuseTool, redactMcpSecrets } from "./mcp-tool-factory.js";

// Row builders + mappers live in `./server-stores.ts`.
export {
  createMcpSecurityPolicyInsert,
  createMcpServerInsert,
  createMcpServerUpdate,
  mapMcpSecurityPolicyRow,
  mapMcpServerRow
} from "./server-stores.js";

export * from "./loopback-helpers.js";
export * from "./provider-routing.js";
export { evaluateArithmeticExpression } from "./arithmetic.js";
export {
  createLoopbackMcpConnection,
  createLoopbackMcpMuseTools,
  type BuiltinLoopbackOptions,
  type LoopbackMcpServer,
  type LoopbackMcpToolDefinition
} from "./loopback.js";

// Server-side (Muse AS an MCP server) transport bridge lives in `./serve.ts`.
export { createMuseToolsMcpServer, runStdioMcpServer, type MuseToolsMcpServerOptions } from "./serve.js";

export {
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  chromeDevToolsToolRisk,
  createChromeDevToolsMcpServer,
  withChromeDevToolsRisk,
  type ChromeDevToolsMcpOptions
} from "./chrome-devtools-mcp.js";

export {
  GITHUB_MCP_SERVER_NAME,
  LINEAR_MCP_SERVER_NAME,
  NOTION_MCP_SERVER_NAME,
  OFFICIAL_MCP_PRESETS,
  SENTRY_MCP_SERVER_NAME,
  createGitHubMcpServer,
  createLinearMcpServer,
  createNotionMcpServer,
  createSentryMcpServer,
  githubMcpToolRisk,
  linearMcpToolRisk,
  notionMcpToolRisk,
  resolveOfficialMcpPreset,
  sentryMcpToolRisk,
  withOfficialMcpRisk,
  type OfficialMcpPreset,
  type OfficialMcpPresetOptions
} from "./official-mcp-presets.js";

