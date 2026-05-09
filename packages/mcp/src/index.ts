import { lookup } from "node:dns/promises";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpSecurityPolicyTable, McpServerTable, MuseDatabase } from "@muse/db";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { MuseTool, ToolRisk } from "@muse/tools";
import type { Insertable, Kysely, Selectable } from "kysely";

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

type McpServerRow = Selectable<McpServerTable>;
type McpServerInsert = Insertable<McpServerTable>;
type McpSecurityPolicyRow = Selectable<McpSecurityPolicyTable>;
type McpSecurityPolicyInsert = Insertable<McpSecurityPolicyTable>;

const defaultAllowedStdioCommands = ["npx", "node", "python", "python3", "uvx", "uv", "docker", "deno", "bun"] as const;
const defaultMaxToolOutputLength = 50_000;
const defaultMcpRequestTimeoutMs = 15_000;
const defaultMcpReconnectPolicy: McpReconnectPolicy = {
  enabled: true,
  initialDelayMs: 1_000,
  maxAttempts: 3,
  maxDelayMs: 30_000
};
const minToolOutputLength = 1_024;
const maxToolOutputLength = 500_000;
const singletonPolicyId = "default";

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

export class DefaultMcpTransportConnector implements McpTransportConnector {
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly allowPrivateAddresses: boolean;
  private readonly stderr: StdioServerParameters["stderr"];

  constructor(options: DefaultMcpTransportConnectorOptions = {}) {
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
    this.clientName = options.clientName ?? "muse";
    this.clientVersion = options.clientVersion ?? "1.0.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultMcpRequestTimeoutMs;
    this.stderr = options.stderr ?? "inherit";
  }

  async connect(server: McpServer, policy: McpSecurityPolicy): Promise<McpConnection> {
    const validation = validateMcpServer(server, policy, {
      allowPrivateAddresses: this.allowPrivateAddresses
    });

    if (!validation.valid) {
      throw new McpConnectionError(validation.reason ?? "MCP server validation failed");
    }

    const client = new Client({
      name: this.clientName,
      version: this.clientVersion
    });

    try {
      await this.validateRemoteHost(server);
      const transport = this.createTransport(server, policy);

      await client.connect(transport, { timeout: this.requestTimeoutMs });
      return new SdkMcpConnection(client, this.requestTimeoutMs);
    } catch (error) {
      await closeQuietly(client);
      throw new McpConnectionError(toErrorMessage(error));
    }
  }

  private createTransport(server: McpServer, policy: McpSecurityPolicy): Transport {
    if (server.transportType === "stdio") {
      return this.createStdioTransport(server, policy);
    }

    if (server.transportType === "sse") {
      return new SSEClientTransport(this.resolveRemoteUrl(server), {
        requestInit: createRemoteRequestInit(server)
      });
    }

    if (server.transportType === "streamable") {
      return new StreamableHTTPClientTransport(this.resolveRemoteUrl(server), {
        requestInit: createRemoteRequestInit(server)
      });
    }

    throw new McpConnectionError("HTTP MCP transport is deprecated; use streamable instead");
  }

  private createStdioTransport(server: McpServer, policy: McpSecurityPolicy): StdioClientTransport {
    const command = typeof server.config.command === "string" ? server.config.command : undefined;
    const args = resolveStdioArgs(server);

    if (!command || !validateStdioCommand(command, server.name, policy)) {
      throw new McpConnectionError("STDIO command is not allowed");
    }

    if (!validateStdioArgs(args, server.name)) {
      throw new McpConnectionError("STDIO args contain unsafe control characters");
    }

    return new StdioClientTransport({
      args: [...args],
      command,
      cwd: resolveOptionalString(server.config.cwd),
      env: resolveStdioEnv(server.config.env),
      stderr: this.stderr
    });
  }

  private resolveRemoteUrl(server: McpServer): URL {
    const url = resolveOptionalString(server.config.url);

    if (!url || !isPublicHttpUrl(url, { allowPrivateAddresses: this.allowPrivateAddresses })) {
      throw new McpConnectionError("Remote MCP URL is not allowed");
    }

    return new URL(url);
  }

  private async validateRemoteHost(server: McpServer): Promise<void> {
    if (this.allowPrivateAddresses || (server.transportType !== "sse" && server.transportType !== "streamable")) {
      return;
    }

    const url = this.resolveRemoteUrl(server);

    try {
      const addresses = await lookup(url.hostname, { all: true });

      if (addresses.length === 0 || addresses.some((address) => isPrivateOrReservedHost(address.address))) {
        throw new McpConnectionError("Remote MCP URL resolves to a private or reserved address");
      }
    } catch (error) {
      if (error instanceof McpConnectionError) {
        throw error;
      }

      throw new McpConnectionError("Remote MCP URL host could not be verified");
    }
  }
}

class SdkMcpConnection implements McpConnection {
  constructor(
    private readonly client: Client,
    private readonly requestTimeoutMs: number
  ) {}

  async listTools(): Promise<readonly McpRemoteTool[]> {
    const result = await this.client.listTools(undefined, { timeout: this.requestTimeoutMs });

    return result.tools.map((tool) => ({
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: toJsonObject(normalizeJsonValue(tool.inputSchema)),
      name: tool.name,
      risk: riskFromMcpAnnotations(tool.annotations)
    }));
  }

  async callTool(toolName: string, args: JsonObject): Promise<string | JsonValue> {
    const result = await this.client.callTool(
      {
        arguments: args,
        name: toolName
      },
      undefined,
      { timeout: this.requestTimeoutMs }
    );

    return formatMcpToolResult(result);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class KyselyMcpServerStore implements McpServerStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyMcpServerStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("mcp_server"));
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<readonly McpServer[]> {
    const rows = await this.db.selectFrom("mcp_servers").selectAll().orderBy("created_at", "asc").execute();
    return rows.map(mapMcpServerRow);
  }

  async findByName(name: string): Promise<McpServer | undefined> {
    const row = await this.db.selectFrom("mcp_servers").selectAll().where("name", "=", name).executeTakeFirst();
    return row ? mapMcpServerRow(row) : undefined;
  }

  async save(input: McpServerInput): Promise<McpServer> {
    const row = await this.db
      .insertInto("mcp_servers")
      .values(createMcpServerInsert(input, { idFactory: this.idFactory, now: this.now }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapMcpServerRow(row);
  }

  async update(name: string, input: McpServerInput): Promise<McpServer | undefined> {
    const row = await this.db
      .updateTable("mcp_servers")
      .set(createMcpServerUpdate(input, this.now))
      .where("name", "=", name)
      .returningAll()
      .executeTakeFirst();

    return row ? mapMcpServerRow(row) : undefined;
  }

  async delete(name: string): Promise<void> {
    await this.db.deleteFrom("mcp_servers").where("name", "=", name).execute();
  }
}

export class KyselyMcpSecurityPolicyStore implements McpSecurityPolicyStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyMcpSecurityPolicyStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getOrNull(): Promise<McpSecurityPolicy | undefined> {
    const row = await this.db
      .selectFrom("mcp_security_policy")
      .selectAll()
      .where("id", "=", singletonPolicyId)
      .executeTakeFirst();

    return row ? mapMcpSecurityPolicyRow(row) : undefined;
  }

  async save(input: McpSecurityPolicyInput): Promise<McpSecurityPolicy> {
    const row = createMcpSecurityPolicyInsert(input, this.now);
    const saved = await this.db
      .insertInto("mcp_security_policy")
      .values(row)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          allowed_server_names: row.allowed_server_names,
          allowed_stdio_commands: row.allowed_stdio_commands,
          max_tool_output_length: row.max_tool_output_length,
          updated_at: row.updated_at
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapMcpSecurityPolicyRow(saved);
  }

  async delete(): Promise<boolean> {
    const result = await this.db
      .deleteFrom("mcp_security_policy")
      .where("id", "=", singletonPolicyId)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0n) > 0;
  }
}

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

export function validateMcpServer(
  server: McpServer,
  policy: McpSecurityPolicy,
  options: McpServerValidationOptions = {}
): {
  readonly reason?: string;
  readonly valid: boolean;
} {
  if (server.name.trim().length === 0) {
    return { reason: "MCP server name is required", valid: false };
  }

  if (server.transportType === "stdio") {
    const command = typeof server.config.command === "string" ? server.config.command : undefined;

    if (!command || !validateStdioCommand(command, server.name, policy)) {
      return { reason: "STDIO command is not allowed", valid: false };
    }

    if (!validateStdioArgs(resolveStdioArgs(server), server.name)) {
      return { reason: "STDIO args contain unsafe control characters", valid: false };
    }
  }

  if (server.transportType === "http") {
    return { reason: "HTTP MCP transport is deprecated; use streamable instead", valid: false };
  }

  if (server.transportType === "sse" || server.transportType === "streamable") {
    const url = typeof server.config.url === "string" ? server.config.url : undefined;

    if (!url || !isPublicHttpUrl(url, options)) {
      return { reason: "Remote MCP URL is not allowed", valid: false };
    }
  }

  return { valid: true };
}

export function validateStdioCommand(command: string, _serverName: string, policy: McpSecurityPolicy): boolean {
  return !command.includes("..") &&
    !command.includes("/") &&
    !command.includes("\\") &&
    policy.allowedStdioCommands.includes(command);
}

export function validateStdioArgs(args: readonly string[], _serverName: string): boolean {
  return args.every((arg) => !/[\x00-\x08\x0B-\x1F]/u.test(arg));
}

export function isPrivateOrReservedHost(host: string | undefined): boolean {
  if (!host) {
    return true;
  }

  const normalized = host.toLowerCase();

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = net.isIP(normalized);

  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 4) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0] = parts;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  return normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80");
}

export function isPublicHttpUrl(value: string, options: McpServerValidationOptions = {}): boolean {
  try {
    const url = new URL(value);

    return (url.protocol === "https:" || url.protocol === "http:") &&
      (options.allowPrivateAddresses || !isPrivateOrReservedHost(url.hostname));
  } catch {
    return false;
  }
}

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

export function createMcpServerInsert(
  input: McpServerInput,
  options: Required<KyselyMcpServerStoreOptions>
): McpServerInsert {
  const server = normalizeMcpServerInput(input, {
    id: input.id ?? options.idFactory(),
    now: options.now
  });

  return {
    auto_connect: server.autoConnect,
    config: server.config,
    created_at: server.createdAt,
    description: server.description ?? null,
    id: server.id,
    name: server.name,
    transport_type: server.transportType,
    updated_at: server.updatedAt,
    version: server.version ?? null
  };
}

export function createMcpServerUpdate(input: McpServerInput, now: () => Date) {
  return {
    auto_connect: input.autoConnect ?? false,
    config: input.config ?? {},
    description: input.description ?? null,
    transport_type: input.transportType,
    updated_at: input.updatedAt ?? now(),
    version: input.version ?? null
  };
}

export function createMcpSecurityPolicyInsert(
  input: McpSecurityPolicyInput,
  now: () => Date
): McpSecurityPolicyInsert {
  const timestamp = now();
  const policy = normalizeMcpSecurityPolicy(input, timestamp);

  return {
    allowed_server_names: [...policy.allowedServerNames],
    allowed_stdio_commands: [...policy.allowedStdioCommands],
    created_at: policy.createdAt,
    id: singletonPolicyId,
    max_tool_output_length: policy.maxToolOutputLength,
    updated_at: policy.updatedAt
  };
}

export function mapMcpServerRow(row: McpServerRow): McpServer {
  return {
    autoConnect: row.auto_connect,
    config: toJsonObject(row.config),
    createdAt: toDate(row.created_at),
    description: row.description ?? undefined,
    id: row.id,
    name: row.name,
    transportType: row.transport_type,
    updatedAt: toDate(row.updated_at),
    version: row.version ?? undefined
  };
}

export function mapMcpSecurityPolicyRow(row: McpSecurityPolicyRow): McpSecurityPolicy {
  return normalizeMcpSecurityPolicy(
    {
      allowedServerNames: toStringArray(row.allowed_server_names),
      allowedStdioCommands: toStringArray(row.allowed_stdio_commands),
      maxToolOutputLength: row.max_tool_output_length
    },
    toDate(row.updated_at)
  );
}

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

function resolveStdioArgs(server: McpServer): readonly string[] {
  return Array.isArray(server.config.args)
    ? server.config.args.filter((arg): arg is string => typeof arg === "string")
    : [];
}

function resolveOptionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveStdioEnv(value: JsonValue | undefined): Record<string, string> | undefined {
  const custom = resolveStringRecord(value);
  return custom ? { ...getDefaultEnvironment(), ...custom } : undefined;
}

function resolveStringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function createRemoteRequestInit(server: McpServer): RequestInit | undefined {
  const token = resolveOptionalString(server.config.authToken) ?? resolveOptionalString(server.config.bearerToken);

  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

function riskFromMcpAnnotations(annotations: unknown): ToolRisk {
  if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) {
    return "read";
  }

  const values = annotations as Record<string, unknown>;

  if (values.destructiveHint === true) {
    return "execute";
  }

  if (values.readOnlyHint === false || values.idempotentHint === false) {
    return "write";
  }

  return "read";
}

function formatMcpToolResult(result: unknown): string | JsonValue {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return normalizeJsonValue(result);
  }

  const value = result as Record<string, unknown>;
  const prefix = value.isError === true ? "Error: " : "";

  if ("structuredContent" in value && value.structuredContent !== undefined) {
    return value.isError === true
      ? `${prefix}${JSON.stringify(value.structuredContent)}`
      : normalizeJsonValue(value.structuredContent);
  }

  if (Array.isArray(value.content)) {
    const textBlocks = value.content
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return undefined;
        }

        const block = item as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
      })
      .filter((text): text is string => typeof text === "string");

    if (textBlocks.length === value.content.length) {
      return `${prefix}${textBlocks.join("\n")}`;
    }

    return value.isError === true ? `${prefix}${JSON.stringify(value.content)}` : normalizeJsonValue(value.content);
  }

  if ("toolResult" in value) {
    return value.isError === true ? `${prefix}${String(value.toolResult)}` : normalizeJsonValue(value.toolResult);
  }

  return value.isError === true ? `${prefix}${JSON.stringify(value)}` : normalizeJsonValue(value);
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? null : value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined && typeof entry[1] !== "function" && typeof entry[1] !== "symbol")
        .map(([key, item]) => [key, normalizeJsonValue(item)])
    );
  }

  return String(value);
}

function toJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Best-effort cleanup after failed MCP initialization.
  }
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

// Notes provider abstraction. LocalDir is a real adapter; AppleNotes
// Apple Notes is a real osascript adapter (macOS-only); Notion is
// still a typed scaffold that throws NOT_IMPLEMENTED.
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
