import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { MuseTool, ToolRisk } from "@muse/tools";

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
}

export interface McpConnection {
  listTools(): Awaitable<readonly McpRemoteTool[]>;
  callTool?(toolName: string, args: JsonObject): Awaitable<string | JsonValue>;
  close?(): Awaitable<void>;
}

export interface McpTransportConnector {
  connect(server: McpServer, policy: McpSecurityPolicy): Promise<McpConnection>;
}

export interface DefaultMcpTransportConnectorOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly allowPrivateAddresses?: boolean;
  readonly stderr?: StdioServerParameters["stderr"];
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

const defaultAllowedStdioCommands = ["npx", "node", "python", "python3", "uvx", "uv", "docker", "deno", "bun"] as const;
const defaultMaxToolOutputLength = 50_000;
const defaultMcpReconnectPolicy: McpReconnectPolicy = {
  enabled: true,
  initialDelayMs: 1_000,
  maxAttempts: 3,
  maxDelayMs: 30_000
};
const minToolOutputLength = 1_024;
const maxToolOutputLength = 500_000;

export class InMemoryMcpServerStore implements McpServerStore {
  static readonly defaultMaxServers = 1_000;

  private readonly idFactory: () => string;
  private readonly maxServers: number;
  private readonly now: () => Date;
  private readonly servers = new Map<string, McpServer>();

  constructor(options: InMemoryMcpServerStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("mcp_server"));
    this.maxServers = options.maxServers ?? InMemoryMcpServerStore.defaultMaxServers;
    this.now = options.now ?? (() => new Date());
  }

  list(): readonly McpServer[] {
    return [...this.servers.values()].sort(compareServers);
  }

  findByName(name: string): McpServer | undefined {
    return this.servers.get(name);
  }

  save(input: McpServerInput): McpServer {
    if (this.servers.has(input.name)) {
      throw new McpRegistryError(`MCP server already exists: ${input.name}`);
    }

    const server = normalizeMcpServerInput(input, {
      id: input.id ?? this.idFactory(),
      now: this.now
    });

    this.servers.set(server.name, server);
    this.evictOverflow();
    return server;
  }

  update(name: string, input: McpServerInput): McpServer | undefined {
    const existing = this.servers.get(name);

    if (!existing) {
      return undefined;
    }

    const updated = normalizeMcpServerInput(
      {
        ...input,
        id: existing.id,
        name,
        createdAt: existing.createdAt
      },
      {
        id: existing.id,
        now: this.now
      }
    );

    this.servers.set(name, updated);
    return updated;
  }

  delete(name: string): void {
    this.servers.delete(name);
  }

  private evictOverflow(): void {
    while (this.servers.size > this.maxServers) {
      const oldest = this.list()[0];

      if (!oldest) {
        return;
      }

      this.servers.delete(oldest.name);
    }
  }
}

export class InMemoryMcpSecurityPolicyStore implements McpSecurityPolicyStore {
  private readonly now: () => Date;
  private policy?: McpSecurityPolicy;

  constructor(options: InMemoryMcpSecurityPolicyStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.policy = options.initial ? normalizeMcpSecurityPolicy(options.initial, this.now()) : undefined;
  }

  getOrNull(): McpSecurityPolicy | undefined {
    return this.policy;
  }

  save(input: McpSecurityPolicyInput): McpSecurityPolicy {
    const now = this.now();
    const saved = {
      ...normalizeMcpSecurityPolicy(input, now),
      createdAt: this.policy?.createdAt ?? now,
      updatedAt: now
    };

    this.policy = saved;
    return saved;
  }

  delete(): boolean {
    const existed = Boolean(this.policy);
    this.policy = undefined;
    return existed;
  }
}

export class McpSecurityPolicyProvider {
  constructor(
    private readonly store: McpSecurityPolicyStore = new InMemoryMcpSecurityPolicyStore(),
    private readonly defaults: McpSecurityPolicyInput = {}
  ) {}

  async currentPolicy(): Promise<McpSecurityPolicy> {
    const stored = await this.store.getOrNull();

    if (stored) {
      return normalizeMcpSecurityPolicy(stored, stored.updatedAt);
    }

    return this.configDefaultPolicy();
  }

  configDefaultPolicy(): McpSecurityPolicy {
    return normalizeMcpSecurityPolicy(this.defaults, new Date(0));
  }

  async isServerAllowed(serverName: string): Promise<boolean> {
    const policy = await this.currentPolicy();

    return policy.allowedServerNames.length === 0 || policy.allowedServerNames.includes(serverName);
  }
}

export class McpManager {
  private readonly connector?: McpTransportConnector;
  private readonly now: () => Date;
  private readonly reconnectPolicy: McpReconnectPolicy;
  private readonly securityPolicyProvider: McpSecurityPolicyProvider;
  private readonly validation: McpServerValidationOptions;
  private readonly statuses = new Map<string, McpServerStatus>();
  private readonly connections = new Map<string, McpConnection>();
  private readonly health = new Map<string, McpHealthSnapshot>();
  private readonly tools = new Map<string, readonly McpRemoteTool[]>();

  constructor(
    private readonly store: McpServerStore = new InMemoryMcpServerStore(),
    options: McpManagerOptions = {}
  ) {
    this.connector = options.connector;
    this.now = options.now ?? (() => new Date());
    this.reconnectPolicy = normalizeReconnectPolicy(options.reconnect);
    this.securityPolicyProvider = options.securityPolicyProvider ?? new McpSecurityPolicyProvider();
    this.store = options.store ?? store;
    this.validation = options.validation ?? {};
  }

  async register(input: McpServerInput): Promise<McpServer | undefined> {
    const policy = await this.securityPolicyProvider.currentPolicy();

    if (!(policy.allowedServerNames.length === 0 || policy.allowedServerNames.includes(input.name))) {
      this.statuses.set(input.name, "disabled");
      this.health.set(input.name, this.createHealthSnapshot(input.name, "unhealthy", "Server denied by policy"));
      return undefined;
    }

    const validation = validateMcpServer(
      normalizeMcpServerInput(input, {
        id: input.id ?? "mcp_server_validation",
        now: this.now
      }),
      policy,
      this.validation
    );

    if (!validation.valid) {
      this.statuses.set(input.name, "disabled");
      this.health.set(input.name, this.createHealthSnapshot(
        input.name,
        "unhealthy",
        validation.reason ?? "MCP server validation failed"
      ));
      return undefined;
    }

    const saved = await this.store.save(input);
    this.statuses.set(saved.name, "pending");
    this.health.set(saved.name, this.createHealthSnapshot(saved.name, "unknown"));
    return saved;
  }

  async syncRuntimeServer(input: McpServerInput): Promise<McpServer | undefined> {
    const existing = await this.store.findByName(input.name);

    if (!existing) {
      return this.register(input);
    }

    return this.store.update(input.name, input);
  }

  async unregister(name: string): Promise<void> {
    await this.disconnect(name);
    await this.store.delete(name);
    this.statuses.delete(name);
    this.health.delete(name);
    this.tools.delete(name);
  }

  async initializeFromStore(): Promise<void> {
    for (const server of await this.store.list()) {
      this.statuses.set(server.name, "pending");
      this.health.set(server.name, this.createHealthSnapshot(server.name, "unknown"));

      if (server.autoConnect) {
        await this.connect(server.name);
      }
    }
  }

  async connect(name: string): Promise<boolean> {
    const server = await this.store.findByName(name);

    if (!server || !(await this.securityPolicyProvider.isServerAllowed(name)) || !this.connector) {
      this.statuses.set(name, server ? "disabled" : "failed");
      this.scheduleReconnect(name, server ? "Server denied or connector unavailable" : "Server not found");
      return false;
    }

    const validation = validateMcpServer(server, await this.securityPolicyProvider.currentPolicy(), this.validation);

    if (!validation.valid) {
      this.statuses.set(name, "failed");
      this.scheduleReconnect(name, validation.reason ?? "MCP server validation failed");
      return false;
    }

    this.statuses.set(name, "connecting");

    try {
      const connection = await this.connector.connect(server, await this.securityPolicyProvider.currentPolicy());
      const tools = await connection.listTools();

      this.connections.set(name, connection);
      this.tools.set(name, tools);
      this.statuses.set(name, "connected");
      this.health.set(name, this.createHealthSnapshot(name, "healthy"));
      return true;
    } catch (error) {
      this.statuses.set(name, "failed");
      this.scheduleReconnect(name, toErrorMessage(error));
      return false;
    }
  }

  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);

    try {
      await connection?.close?.();
    } finally {
      this.connections.delete(name);
      this.tools.delete(name);
      this.statuses.set(name, "disconnected");
      this.health.set(name, this.createHealthSnapshot(name, "unknown"));
    }
  }

  async listServers(): Promise<readonly McpServer[]> {
    return this.store.list();
  }

  getStatus(name: string): McpServerStatus | undefined {
    return this.statuses.get(name);
  }

  getHealth(name: string): McpHealthSnapshot {
    return this.health.get(name) ?? this.createHealthSnapshot(name, "unknown");
  }

  async healthCheck(name: string): Promise<McpHealthSnapshot> {
    const connection = this.connections.get(name);

    if (!connection || this.statuses.get(name) !== "connected") {
      const snapshot = this.createHealthSnapshot(name, "unknown", "MCP server is not connected");
      this.health.set(name, snapshot);
      return snapshot;
    }

    try {
      const tools = await connection.listTools();
      this.tools.set(name, tools);
      this.statuses.set(name, "connected");

      const snapshot = this.createHealthSnapshot(name, "healthy");
      this.health.set(name, snapshot);
      return snapshot;
    } catch (error) {
      await closeConnectionQuietly(connection);
      this.connections.delete(name);
      this.tools.delete(name);
      this.statuses.set(name, "failed");
      return this.scheduleReconnect(name, toErrorMessage(error));
    }
  }

  async healthCheckAll(): Promise<readonly McpHealthSnapshot[]> {
    return Promise.all((await this.store.list()).map((server) => this.healthCheck(server.name)));
  }

  async preflight(name: string): Promise<McpPreflightReport> {
    const server = await this.store.findByName(name);
    const checks: McpPreflightCheck[] = [];
    const status = this.statuses.get(name) ?? (server ? "pending" : "failed");

    if (!server) {
      checks.push({
        code: "server_registered",
        message: `MCP server '${name}' is not registered`,
        status: "fail"
      });
      return this.createPreflightReport(name, status, checks);
    }

    checks.push({
      code: "server_registered",
      message: `MCP server '${name}' is registered`,
      status: "pass"
    });

    const policy = await this.securityPolicyProvider.currentPolicy();
    const allowed = policy.allowedServerNames.length === 0 || policy.allowedServerNames.includes(name);
    checks.push({
      code: "security_policy",
      message: allowed
        ? `MCP server '${name}' is allowed by security policy`
        : `MCP server '${name}' is denied by security policy`,
      status: allowed ? "pass" : "fail"
    });

    const validation = validateMcpServer(server, policy, this.validation);
    checks.push({
      code: "server_config",
      message: validation.valid ? "MCP server configuration is valid" : validation.reason ?? "MCP server configuration is invalid",
      status: validation.valid ? "pass" : "fail"
    });

    checks.push({
      code: "transport_connector",
      message: this.connector ? "MCP transport connector is configured" : "MCP transport connector is not configured",
      status: this.connector ? "pass" : "warn"
    });

    checks.push({
      code: "runtime_connection",
      message: status === "connected"
        ? `MCP server '${name}' is connected with ${this.tools.get(name)?.length ?? 0} tools`
        : `MCP server '${name}' is not connected`,
      status: status === "connected" ? "pass" : "warn"
    });

    return this.createPreflightReport(name, status, checks);
  }

  async reconnect(name: string): Promise<boolean> {
    if (this.connections.has(name)) {
      await this.disconnect(name);
    }

    this.health.set(name, this.createHealthSnapshot(name, "unknown"));
    return this.connect(name);
  }

  async reconnectDue(): Promise<readonly McpHealthSnapshot[]> {
    const now = this.now().getTime();
    const due = [...this.health.values()].filter((snapshot) =>
      snapshot.nextReconnectAt !== undefined && snapshot.nextReconnectAt.getTime() <= now
    );
    const results: McpHealthSnapshot[] = [];

    for (const snapshot of due) {
      await this.reconnect(snapshot.serverName);
      results.push(this.getHealth(snapshot.serverName));
    }

    return results;
  }

  getToolCatalog(name?: string): readonly McpRemoteTool[] {
    if (name) {
      return this.tools.get(name) ?? [];
    }

    return [...this.tools.values()].flat();
  }

  toMuseTools(): readonly MuseTool[] {
    return [...this.connections.entries()].flatMap(([serverName, connection]) =>
      (this.tools.get(serverName) ?? []).map((tool) => createMcpMuseTool(serverName, tool, connection))
    );
  }

  private scheduleReconnect(name: string, error: string): McpHealthSnapshot {
    const previous = this.health.get(name);
    const attempts = (previous?.reconnectAttempts ?? 0) + 1;
    const nextReconnectAt = this.nextReconnectAt(attempts);
    const snapshot = this.createHealthSnapshot(name, "unhealthy", error, attempts, nextReconnectAt);

    this.health.set(name, snapshot);
    return snapshot;
  }

  private nextReconnectAt(attempts: number): Date | undefined {
    if (!this.reconnectPolicy.enabled || attempts > this.reconnectPolicy.maxAttempts) {
      return undefined;
    }

    const delay = Math.min(
      this.reconnectPolicy.maxDelayMs,
      this.reconnectPolicy.initialDelayMs * (2 ** Math.max(0, attempts - 1))
    );

    return new Date(this.now().getTime() + delay);
  }

  private createHealthSnapshot(
    serverName: string,
    status: McpHealthStatus,
    error?: string,
    reconnectAttempts = 0,
    nextReconnectAt?: Date
  ): McpHealthSnapshot {
    return {
      checkedAt: this.now(),
      ...(error ? { error } : {}),
      ...(nextReconnectAt ? { nextReconnectAt } : {}),
      reconnectAttempts,
      serverName,
      status,
      toolCount: this.tools.get(serverName)?.length ?? 0
    };
  }

  private createPreflightReport(
    serverName: string,
    status: McpServerStatus,
    checks: readonly McpPreflightCheck[]
  ): McpPreflightReport {
    const summary = {
      failCount: checks.filter((check) => check.status === "fail").length,
      passCount: checks.filter((check) => check.status === "pass").length,
      warnCount: checks.filter((check) => check.status === "warn").length
    };

    return {
      checks,
      health: this.getHealth(serverName),
      ok: summary.failCount === 0,
      readyForProduction: summary.failCount === 0 && summary.warnCount === 0,
      serverName,
      status,
      summary
    };
  }
}

// Transport connector + SDK connection adapter live in `./transport.ts`
// (round 141 lift). Re-export so external call-sites stay byte-identical.
export { DefaultMcpTransportConnector } from "./transport.js";

// Kysely-backed persistence lives in `packages/mcp/src/server-stores.ts`
// (round 139 lift). Re-export so existing call-sites stay byte-identical.
export { KyselyMcpSecurityPolicyStore, KyselyMcpServerStore } from "./server-stores.js";


export class McpRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRegistryError";
  }
}

export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConnectionError";
  }
}

export function normalizeMcpServerInput(
  input: McpServerInput,
  options: {
    readonly id: string;
    readonly now: () => Date;
  }
): McpServer {
  const createdAt = input.createdAt ?? options.now();

  return {
    autoConnect: input.autoConnect ?? false,
    config: input.config ?? {},
    createdAt,
    description: input.description ?? undefined,
    id: options.id,
    name: input.name,
    transportType: input.transportType,
    updatedAt: input.updatedAt ?? createdAt,
    version: input.version ?? undefined
  };
}

export function normalizeMcpSecurityPolicy(input: McpSecurityPolicyInput, now: Date): McpSecurityPolicy {
  return {
    allowedServerNames: uniqueStrings(input.allowedServerNames ?? []),
    allowedStdioCommands: uniqueStrings(input.allowedStdioCommands ?? defaultAllowedStdioCommands),
    createdAt: "createdAt" in input && input.createdAt instanceof Date ? input.createdAt : now,
    maxToolOutputLength: clamp(
      input.maxToolOutputLength ?? defaultMaxToolOutputLength,
      minToolOutputLength,
      maxToolOutputLength
    ),
    updatedAt: "updatedAt" in input && input.updatedAt instanceof Date ? input.updatedAt : now
  };
}

export function normalizeReconnectPolicy(input: Partial<McpReconnectPolicy> | undefined): McpReconnectPolicy {
  return {
    enabled: input?.enabled ?? defaultMcpReconnectPolicy.enabled,
    initialDelayMs: positiveInteger(input?.initialDelayMs, defaultMcpReconnectPolicy.initialDelayMs),
    maxAttempts: positiveInteger(input?.maxAttempts, defaultMcpReconnectPolicy.maxAttempts),
    maxDelayMs: positiveInteger(input?.maxDelayMs, defaultMcpReconnectPolicy.maxDelayMs)
  };
}

// Validators live in `./validators.ts` (round 140 lift). Two-step
// import + export so external call-sites stay byte-identical and
// the local `validateMcpServer` / `validateStdioCommand` /
// `validateStdioArgs` references inside this file (transport +
// manager) still resolve.
import {
  isPrivateOrReservedHost,
  isPublicHttpUrl,
  validateMcpServer,
  validateStdioArgs,
  validateStdioCommand
} from "./validators.js";

export {
  isPrivateOrReservedHost,
  isPublicHttpUrl,
  validateMcpServer,
  validateStdioArgs,
  validateStdioCommand
};

export function createMcpMuseTool(serverName: string, tool: McpRemoteTool, connection: McpConnection): MuseTool {
  return {
    definition: {
      description: tool.description,
      inputSchema: tool.inputSchema ?? {},
      name: `${serverName}.${tool.name}`,
      risk: tool.risk ?? "read"
    },
    execute: async (args) => {
      if (!connection.callTool) {
        return `Error: MCP tool '${tool.name}' is not callable`;
      }

      return connection.callTool(tool.name, args);
    }
  };
}

// Row builders + mappers live in `./server-stores.ts` (round 139 lift).
// Re-exported so external call-sites stay byte-identical.
export {
  createMcpSecurityPolicyInsert,
  createMcpServerInsert,
  createMcpServerUpdate,
  mapMcpSecurityPolicyRow,
  mapMcpServerRow
} from "./server-stores.js";


function compareServers(left: McpServer, right: McpServer): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.name.localeCompare(right.name);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toStringArray(value: JsonValue): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}


async function closeConnectionQuietly(connection: McpConnection): Promise<void> {
  try {
    await connection.close?.();
  } catch {
    // Best-effort cleanup after failed MCP health checks.
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  createCryptoMcpServer,
  createDefaultLoopbackMcpServers,
  createCalendarMcpServer,
  createTasksMcpServer,
  createDiffMcpServer,
  createFetchMcpServer,
  createFilesystemMcpServer,
  describeBuiltinLoopbackMcpServers,
  createJsonMcpServer,
  createLoopbackMcpConnection,
  createLoopbackMcpMuseTools,
  createMathMcpServer,
  createNotesMcpServer,
  createRegexMcpServer,
  createTextUtilsMcpServer,
  createTimeMcpServer,
  createUrlMcpServer,
  type BuiltinLoopbackOptions,
  type FetchMcpServerOptions,
  type FilesystemMcpServerOptions,
  type LoopbackMcpCatalogEntry,
  type LoopbackMcpServer,
  type LoopbackMcpToolDefinition,
  type NotesMcpServerOptions
} from "./loopback.js";

// Notes provider abstraction. LocalDir, Apple Notes (osascript), and
// Notion (api.notion.com) are all real adapters. The `muse.notes-multi`
// MCP server in `loopback-notes-registry.ts` routes between them via
// providerId.
export {
  createNotesRegistryMcpServer,
  type NotesRegistryMcpServerOptions
} from "./loopback-notes-registry.js";

export {
  AppleNotesProvider,
  LocalDirNotesProvider,
  NotesProviderError,
  NotesProviderRegistry,
  NotesValidationError,
  NotionNotesProvider,
  type AppleNotesProviderOptions,
  type LocalDirNotesProviderOptions,
  type NotesAppendInput,
  type NotesContent,
  type NotesEntry,
  type NotesProvider,
  type NotesProviderInfo,
  type NotesSaveInput,
  type NotesSearchHit,
  type NotionNotesProviderOptions
} from "./notes-providers.js";
