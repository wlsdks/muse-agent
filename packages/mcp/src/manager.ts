/**
 * McpManager — the runtime registry that owns MCP server lifecycle:
 * register / connect / health / preflight / reconnect / tool catalog.
 *
 * Lifted out of `packages/mcp/src/index.ts` (round 142, after rounds
 * 139 + 140 + 141 split out the Kysely stores, the validators, and
 * the SDK transport adapter). The abstractions (`McpConnection`,
 * `McpServerStore`, `McpManagerOptions`, the typed `McpServer*` /
 * `McpHealth*` / `McpPreflight*` shapes), the in-memory stores, the
 * security policy provider, the normalisers, the typed errors,
 * and `createMcpMuseTool` all stay in `index.ts`; this file imports
 * them back.
 *
 * Two private helpers come over because they were only used by
 * the manager:
 *   - closeConnectionQuietly (best-effort connection cleanup
 *     after failed health checks)
 *   - toErrorMessage (Error.message / String fallback)
 */

import type { MuseTool } from "@muse/tools";

import {
  InMemoryMcpServerStore,
  McpSecurityPolicyProvider,
  createMcpMuseTool,
  normalizeMcpServerInput,
  normalizeReconnectPolicy,
  type McpConnection,
  type McpHealthSnapshot,
  type McpHealthStatus,
  type McpManagerOptions,
  type McpPreflightCheck,
  type McpPreflightReport,
  type McpReconnectPolicy,
  type McpRemoteTool,
  type McpServer,
  type McpServerInput,
  type McpServerStatus,
  type McpServerStore,
  type McpServerValidationOptions,
  type McpTransportConnector
} from "./index.js";
import { validateMcpServer } from "./validators.js";

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

async function closeConnectionQuietly(connection: McpConnection): Promise<void> {
  try {
    await connection.close?.();
  } catch {
    // Best-effort cleanup after failed MCP health checks.
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
