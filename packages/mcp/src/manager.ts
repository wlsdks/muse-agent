/**
 * McpManager — the runtime registry that owns MCP server lifecycle:
 * register / connect / health / preflight / reconnect / tool catalog.
 *
 * Companion to `packages/mcp/src/index.ts`: the abstractions
 * (`McpConnection`, `McpServerStore`, `McpManagerOptions`, the typed
 * `McpServer*` / `McpHealth*` / `McpPreflight*` shapes), the
 * in-memory stores, the security policy provider, the normalisers,
 * the typed errors, and `createMcpMuseTool` all live in `index.ts`;
 * this file imports them back.
 *
 * One private helper comes over because it was only used by the
 * manager:
 *   - closeConnectionQuietly (best-effort connection cleanup
 *     after failed health checks)
 *
 * `toErrorMessage` (Error.message / String fallback) lives in
 * `./error-utils.js`, shared with `transport.ts` and `index.ts`.
 */

import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { delimiter, join as joinPath } from "node:path";

import type { MuseTool } from "@muse/tools";

import { toErrorMessage } from "./error-utils.js";
import { isRecord } from "@muse/shared";
import {
  InMemoryMcpServerStore,
  MCP_EXTERNAL_TRANSPORT_BLOCKED,
  McpConnectionError,
  McpSecurityPolicyProvider,
  createMcpMuseTool,
  normalizeMcpServerInput,
  normalizeReconnectPolicy,
  type CheckPackageForMalwareAdvisoryOptions,
  type McpConnection,
  type McpConnectionResolution,
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
import { auditMcpServerPackageForMalware } from "./osv-check.js";
import { auditMcpServerConfig } from "./server-audit.js";
import { validateMcpServer } from "./validators.js";

const externalTransportBlockedMessage = "External MCP transport is disabled by the local-only privacy posture";

export class McpManager {
  private readonly connector?: McpTransportConnector;
  private readonly now: () => Date;
  private readonly reconnectPolicy: McpReconnectPolicy;
  private readonly securityPolicyProvider: McpSecurityPolicyProvider;
  private readonly validation: McpServerValidationOptions;
  private readonly osvMalwareCheck?: CheckPackageForMalwareAdvisoryOptions;
  private readonly externalTransportAllowed: boolean;
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
    this.osvMalwareCheck = options.osvMalwareCheck;
    this.externalTransportAllowed = options.externalTransportAllowed ?? true;
  }

  async register(input: McpServerInput): Promise<McpServer | undefined> {
    if (!this.externalTransportAllowed) {
      this.markExternalTransportBlocked(input.name);
      return undefined;
    }

    const policy = await this.securityPolicyProvider.currentPolicy();

    // The `muse.` namespace is RESERVED for Muse's own in-process loopback tools
    // (muse.notes.*, muse.tasks.*, …). Those never come through this manager, so
    // an EXTERNAL server claiming the name is impersonation: its tools would be
    // projected as `muse.notes.<x>` and inherit the trust that name carries in
    // the provenance gate's first-party classification (a taint-cancelling
    // origin). Refuse, don't merely warn.
    if (isReservedServerName(input.name)) {
      this.statuses.set(input.name, "disabled");
      this.health.set(
        input.name,
        this.createHealthSnapshot(input.name, "unhealthy", "Server name denied: the `muse.` namespace is reserved for Muse's own loopback tools")
      );
      return undefined;
    }

    if (!(policy.allowedServerNames.length === 0 || policy.allowedServerNames.includes(input.name))) {
      this.statuses.set(input.name, "disabled");
      this.health.set(input.name, this.createHealthSnapshot(input.name, "unhealthy", "Server denied by policy"));
      return undefined;
    }

    const registerAudit = auditMcpServerConfig({ transportType: input.transportType, config: input.config ?? {} });
    if (!registerAudit.safe) {
      this.statuses.set(input.name, "disabled");
      this.health.set(
        input.name,
        this.createHealthSnapshot(input.name, "unhealthy", auditReason(registerAudit.reasons))
      );
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
    if (!this.externalTransportAllowed) {
      this.markExternalTransportBlocked(input.name);
      return undefined;
    }

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
    if (!this.externalTransportAllowed) {
      await this.materializeBlockedStoredServers();
      return;
    }

    for (const server of await this.store.list()) {
      this.statuses.set(server.name, "pending");
      this.health.set(server.name, this.createHealthSnapshot(server.name, "unknown"));

      if (server.autoConnect) {
        await this.connect(server.name);
      }
    }
  }

  async connect(name: string): Promise<boolean> {
    if (!this.externalTransportAllowed) {
      this.markExternalTransportBlocked(name);
      return false;
    }

    const server = await this.store.findByName(name);

    if (server && !(await this.securityPolicyProvider.isServerAllowed(name))) {
      // Allowlist denial is terminal: disabled + unhealthy, NEVER a
      // reconnect loop. Mirrors register-time denial and the
      // fingerprint-mismatch branch — the policy gates connections,
      // it must not retry one it forbids.
      this.statuses.set(name, "disabled");
      this.health.set(name, this.createHealthSnapshot(name, "unhealthy", "Server denied by security policy"));
      return false;
    }

    if (server) {
      // Static config audit — defense-in-depth past the name allowlist.
      // A server that PASSES the allowlist can still ship a malicious
      // launch line (download-and-exec, command injection, a binary
      // staged in /tmp). Refuse it terminally, exactly like an
      // allowlist denial: disabled + unhealthy, never a reconnect loop.
      const connectAudit = auditMcpServerConfig({ transportType: server.transportType, config: server.config });
      if (!connectAudit.safe) {
        this.statuses.set(name, "disabled");
        this.health.set(name, this.createHealthSnapshot(name, "unhealthy", auditReason(connectAudit.reasons)));
        return false;
      }

      // Live OSV malware-advisory preflight — additional to the static
      // audit above, not a replacement. Opt-in (see `osvMalwareCheck`
      // doc): skipped entirely when unset, so this never adds a network
      // call to a deployment/test that didn't ask for it. When enabled,
      // a genuine MAL-* hit fails CLOSED exactly like the static audit;
      // a network failure fails OPEN inside `auditMcpServerPackageForMalware`
      // itself, so this call always resolves quickly and never blocks
      // `connect()` past the bounded OSV timeout.
      if (this.osvMalwareCheck) {
        const malwareAudit = await auditMcpServerPackageForMalware(
          { config: server.config, transportType: server.transportType },
          this.osvMalwareCheck
        );
        if (!malwareAudit.safe) {
          this.statuses.set(name, "disabled");
          this.health.set(name, this.createHealthSnapshot(name, "unhealthy", auditReason(malwareAudit.reasons)));
          return false;
        }
      }
    }

    if (!server || !this.connector) {
      this.statuses.set(name, server ? "disabled" : "failed");
      this.scheduleReconnect(name, server ? "Connector unavailable" : "Server not found");
      return false;
    }

    const validation = validateMcpServer(server, await this.securityPolicyProvider.currentPolicy(), this.validation);

    if (!validation.valid) {
      this.statuses.set(name, "failed");
      this.scheduleReconnect(name, validation.reason ?? "MCP server validation failed");
      return false;
    }

    // Missing fingerprint = no enforcement (opt-in posture). A
    // mismatch → `disabled` (not `failed`) + an unhealthy
    // diagnostic so the operator sees a clear refusal, not a
    // transient connect attempt.
    const fingerprintVerdict = verifyServerFingerprint(server);
    if (!fingerprintVerdict.matched) {
      this.statuses.set(name, "disabled");
      this.health.set(name, this.createHealthSnapshot(name, "unhealthy", fingerprintVerdict.reason));
      return false;
    }

    this.statuses.set(name, "connecting");

    try {
      const connection = await this.connector.connect(server, await this.securityPolicyProvider.currentPolicy());
      const tools = await connection.listTools();

      if (isDeadConnection(connection)) {
        // The child died BETWEEN connect() returning and listTools()
        // finishing — the tools we just read belong to an already-dead
        // transport. Committing them would cache a stale catalog against a
        // corpse; retire it and arm a reconnect instead.
        await closeConnectionQuietly(connection);
        this.statuses.set(name, "failed");
        this.scheduleReconnect(name, connection.disconnectReason ?? "connection closed during catalog refresh");
        return false;
      }

      this.connections.set(name, connection);
      this.tools.set(name, tools);
      this.statuses.set(name, "connected");
      this.health.set(name, this.createHealthSnapshot(name, "healthy"));
      return true;
    } catch (error) {
      if (error instanceof McpConnectionError && !error.retryable) {
        // A permanent failure (revoked/expired token → 401/403, bad
        // config → 4xx) is terminal, exactly like the allowlist and
        // fingerprint-mismatch branches above: mark it disabled and do
        // NOT arm a reconnect loop. Retrying an external server with a
        // credential that will never work just hammers it; architecture.md
        // requires a 4xx-class failure to fail fast, never retry like a 5xx.
        this.statuses.set(name, "disabled");
        this.health.set(name, this.createHealthSnapshot(name, "unhealthy", toErrorMessage(error)));
        return false;
      }

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
    if (!this.externalTransportAllowed) {
      return this.materializeBlockedStoredServers();
    }

    return this.store.list();
  }

  /** Immutable construction-time posture used by API compatibility routes too. */
  isExternalTransportAllowed(): boolean {
    return this.externalTransportAllowed;
  }

  getStatus(name: string): McpServerStatus | undefined {
    return this.statuses.get(name);
  }

  getHealth(name: string): McpHealthSnapshot {
    return this.health.get(name) ?? this.createHealthSnapshot(name, "unknown");
  }

  async healthCheck(name: string): Promise<McpHealthSnapshot> {
    if (!this.externalTransportAllowed) {
      return this.markExternalTransportBlocked(name);
    }

    const connection = this.connections.get(name);

    if (!connection || this.statuses.get(name) !== "connected") {
      const snapshot = this.createHealthSnapshot(name, "unknown", "MCP server is not connected");
      this.health.set(name, snapshot);
      return snapshot;
    }

    try {
      const tools = await connection.listTools();

      if (isDeadConnection(connection)) {
        // Same mid-refresh race as connect(): the transport closed while
        // listTools() was in flight, so these tools are stale. Retire the
        // dead connection and arm a reconnect rather than caching them.
        await closeConnectionQuietly(connection);
        this.connections.delete(name);
        this.tools.delete(name);
        this.statuses.set(name, "failed");
        return this.scheduleReconnect(name, connection.disconnectReason ?? "connection closed during health check");
      }

      this.tools.set(name, tools);
      this.statuses.set(name, "connected");

      const snapshot = this.createHealthSnapshot(name, "healthy");
      this.health.set(name, snapshot);
      return snapshot;
    } catch (error) {
      await closeConnectionQuietly(connection);
      this.connections.delete(name);
      this.tools.delete(name);

      if (error instanceof McpConnectionError && !error.retryable) {
        // Token revoked / scope lost mid-session → permanent. Terminal,
        // no reconnect loop (same fail-fast rule as connect()).
        this.statuses.set(name, "disabled");
        const snapshot = this.createHealthSnapshot(name, "unhealthy", toErrorMessage(error));
        this.health.set(name, snapshot);
        return snapshot;
      }

      this.statuses.set(name, "failed");
      return this.scheduleReconnect(name, toErrorMessage(error));
    }
  }

  async healthCheckAll(): Promise<readonly McpHealthSnapshot[]> {
    if (!this.externalTransportAllowed) {
      return (await this.materializeBlockedStoredServers()).map((server) => this.getHealth(server.name));
    }

    return Promise.all((await this.store.list()).map((server) => this.healthCheck(server.name)));
  }

  async preflight(name: string): Promise<McpPreflightReport> {
    if (!this.externalTransportAllowed) {
      const server = await this.store.findByName(name);
      const checks: McpPreflightCheck[] = [];

      if (server) {
        this.markExternalTransportBlocked(server.name);
        checks.push({
          code: "server_registered",
          message: "MCP server is registered",
          status: "pass"
        });
      } else {
        checks.push({
          code: "server_registered",
          message: "MCP server is not registered",
          status: "fail"
        });
      }

      checks.push({
        code: "external_mcp_transport",
        message: externalTransportBlockedMessage,
        status: "fail"
      });
      return this.createPreflightReport(name, server ? "disabled" : "failed", checks);
    }

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
    if (!this.externalTransportAllowed) {
      this.markExternalTransportBlocked(name);
      return false;
    }

    // Carry the accumulated attempt count into the interim snapshot.
    // Without it, a failed reconnect's scheduleReconnect would read 0
    // and reset attempts to 1 every cycle — so the exponential backoff
    // never grows past initialDelayMs and maxAttempts is never reached
    // (a dead server retries forever at the fastest interval).
    const priorAttempts = this.health.get(name)?.reconnectAttempts ?? 0;
    if (this.connections.has(name)) {
      await this.disconnect(name);
    }

    this.health.set(name, this.createHealthSnapshot(name, "unknown", undefined, priorAttempts));
    return this.connect(name);
  }

  async reconnectDue(): Promise<readonly McpHealthSnapshot[]> {
    if (!this.externalTransportAllowed) {
      return (await this.materializeBlockedStoredServers()).map((server) => this.getHealth(server.name));
    }

    const now = this.now().getTime();
    const due = [...this.health.values()].filter((snapshot) =>
      snapshot.nextReconnectAt !== undefined && snapshot.nextReconnectAt.getTime() <= now
    );
    const results: McpHealthSnapshot[] = [];

    for (const snapshot of due) {
      try {
        await this.reconnect(snapshot.serverName);
      } catch (error) {
        // One server's reconnect must never abort the whole batch — an
        // unexpected throw here (e.g. the security policy provider's
        // backing store hiccups) would otherwise silently skip EVERY
        // other due server for this tick, and — worse — leave THIS
        // server permanently un-probeable if nothing re-arms it. Park
        // it for another retry (same backoff path as a normal connect
        // failure) instead of letting the exception propagate, then
        // keep processing the rest of the batch.
        this.scheduleReconnect(snapshot.serverName, toErrorMessage(error));
      }
      results.push(this.getHealth(snapshot.serverName));
    }

    return results;
  }

  getToolCatalog(name?: string): readonly McpRemoteTool[] {
    if (!this.externalTransportAllowed) {
      return [];
    }

    if (name) {
      return this.tools.get(name) ?? [];
    }

    return [...this.tools.values()].flat();
  }

  toMuseTools(): readonly MuseTool[] {
    if (!this.externalTransportAllowed) {
      return [];
    }

    return [...this.connections.entries()].flatMap(([serverName, connection]) =>
      (this.tools.get(serverName) ?? []).map((tool) =>
        createMcpMuseTool(serverName, tool, connection, () => this.ensureLiveConnection(serverName))
      )
    );
  }

  /**
   * Resolve the CURRENT live connection for a server at tool-invocation
   * time, self-healing a dead one. This is the `requireConnectedSession`
   * seam: a cached connection whose transport died (stdio child crashed)
   * is retired here and a fresh reconnect attempted, so the NEXT tool call
   * succeeds transparently instead of failing forever. It reuses the
   * connect() reconnect path (same backoff/circuit) and never retry-storms
   * a permanently-down server.
   */
  private async ensureLiveConnection(name: string): Promise<McpConnectionResolution> {
    if (!this.externalTransportAllowed) {
      return { error: externalTransportBlockedMessage };
    }

    const existing = this.connections.get(name);

    if (existing && this.statuses.get(name) === "connected" && !isDeadConnection(existing)) {
      return { connection: existing };
    }

    const disconnectReason = isDeadConnection(existing) ? existing?.disconnectReason : undefined;

    if (existing) {
      await closeConnectionQuietly(existing);
      this.connections.delete(name);
      this.tools.delete(name);
      if (this.statuses.get(name) === "connected") {
        this.statuses.set(name, "failed");
      }
    }

    // A disabled server (non-retryable failure / policy denial) is
    // terminal, and a server still inside its reconnect backoff window (or
    // one that has exhausted maxAttempts) must NOT be hammered on every
    // tool call — surface the disconnect reason without a fresh attempt.
    if (this.statuses.get(name) === "disabled" || !isOnDemandReconnectAllowed(this.health.get(name), this.now().getTime())) {
      return { error: formatDisconnectError(name, disconnectReason, this.health.get(name)?.error) };
    }

    const reconnected = await this.connect(name);
    const fresh = reconnected ? this.connections.get(name) : undefined;
    if (fresh) {
      return { connection: fresh };
    }

    return { error: formatDisconnectError(name, disconnectReason, this.health.get(name)?.error) };
  }

  /**
   * Materialize restart-persisted rows without touching `server.config`.
   * A false-posture manager never owns a live external connection, so this
   * intentionally only removes in-memory exposure; it neither closes nor
   * attempts to validate/connect any stored transport.
   */
  private async materializeBlockedStoredServers(): Promise<readonly McpServer[]> {
    const servers = await this.store.list();
    for (const server of servers) {
      this.markExternalTransportBlocked(server.name);
    }
    return servers;
  }

  private markExternalTransportBlocked(name: string): McpHealthSnapshot {
    this.connections.delete(name);
    this.tools.delete(name);
    this.statuses.set(name, "disabled");
    const snapshot = this.createHealthSnapshot(
      name,
      "unhealthy",
      externalTransportBlockedMessage,
      0,
      undefined,
      MCP_EXTERNAL_TRANSPORT_BLOCKED
    );
    this.health.set(name, snapshot);
    return snapshot;
  }

  private scheduleReconnect(name: string, error: string): McpHealthSnapshot {
    const previous = this.health.get(name);
    const attempts = (previous?.reconnectAttempts ?? 0) + 1;
    const nextReconnectAt = computeNextReconnectAt(this.reconnectPolicy, this.now().getTime(), attempts);
    const snapshot = this.createHealthSnapshot(name, "unhealthy", error, attempts, nextReconnectAt);

    this.health.set(name, snapshot);
    return snapshot;
  }

  private createHealthSnapshot(
    serverName: string,
    status: McpHealthStatus,
    error?: string,
    reconnectAttempts = 0,
    nextReconnectAt?: Date,
    errorCode?: string
  ): McpHealthSnapshot {
    return {
      checkedAt: this.now(),
      ...(error ? { error } : {}),
      ...(errorCode ? { errorCode } : {}),
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
    const summary = summarizePreflightChecks(checks);

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

/**
 * sha256 fingerprint pinning for external MCP server
 * binaries. When `server.config.fingerprintSha256` is set, we
 * resolve the command path, hash its bytes, and compare to the
 * pinned value. Returns `{ matched: true }` when no fingerprint
 * was pinned (matches the empty-allowlist opt-in enforcement
 * posture). Returns `{ matched: false, reason }`
 * on mismatch / unreadable binary / non-stdio transport so the
 * caller flips the server to `disabled` with an unhealthy
 * diagnostic.
 *
 * Hash input: the resolved `command` file bytes. A bare command
 * name (`npx`, `node`) is resolved against `PATH` (which-style)
 * before hashing — hashing the literal name would ENOENT and the
 * pin would never verify the real binary. For `node`-style
 * invocations where the entrypoint script lives in `args[0]`, we
 * also fold that file's bytes into the hash. The hash is read
 * once per connect — production reconnect cycles aren't on a
 * hot enough path for this to matter.
 *
 * Exported for direct unit-test coverage so tests can build a
 * tempfile fixture, compute the expected hash, and verify the
 * happy + mismatch branches without spinning up the manager.
 */
export function verifyServerFingerprint(server: McpServer): { matched: boolean; reason?: string } {
  const pinned = readPinnedFingerprint(server.config);
  if (!pinned) return { matched: true };
  if (server.transportType !== "stdio") {
    return { matched: false, reason: `fingerprint pinning only supported for stdio transport (got ${server.transportType})` };
  }
  const command = readCommandPath(server.config);
  if (!command) {
    return { matched: false, reason: "fingerprint pinned but stdio command path missing from config" };
  }
  const resolvedCommand = resolveExecutablePath(command);
  if (!resolvedCommand) {
    return {
      matched: false,
      reason: `fingerprint pinned but command "${command}" could not be resolved to an executable on PATH — refusing connect`
    };
  }
  const entrypoint = readNodeEntrypointPath(server.config);
  const hash = createHash("sha256");
  try {
    hash.update(readFileSync(resolvedCommand));
    if (entrypoint) hash.update(readFileSync(entrypoint));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { matched: false, reason: `fingerprint check could not read binary: ${message}` };
  }
  const actual = hash.digest("hex");
  if (actual !== pinned) {
    return { matched: false, reason: `fingerprint mismatch — refused on connect (sha256 differs from pinned value)` };
  }
  return { matched: true };
}

function readPinnedFingerprint(config: unknown): string | undefined {
  if (!isRecord(config)) return undefined;
  const value = config.fingerprintSha256;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(trimmed) ? trimmed : undefined;
}

function readCommandPath(config: unknown): string | undefined {
  if (!isRecord(config)) return undefined;
  const c = config.command;
  return typeof c === "string" && c.length > 0 ? c : undefined;
}

/**
 * Resolve a stdio `command` to the real executable file we hash.
 * A stdio MCP `command` is frequently a BARE name (`npx`, `node`,
 * `uvx`) rather than a path — `readFileSync("npx")` would ENOENT, so
 * the pin must walk `PATH` (which-style) to find the actual binary
 * before hashing. An absolute/relative path is used as-is when it
 * points at a real file. Returns `undefined` (fail-closed: caller
 * refuses the connect) when no executable can be found, so a missing
 * binary never silently passes the pin.
 */
function resolveExecutablePath(command: string): string | undefined {
  // A win32 absolute/relative path carries backslashes and no "/" — it is
  // still a PATH-bypassing direct path, not a bare command name.
  if (command.includes("/") || command.includes("\\")) {
    return isRegularFile(command) ? command : undefined;
  }
  const pathEnv = process.env.PATH ?? "";
  const pathExtEnv = process.platform === "win32" ? process.env.PATHEXT ?? "" : "";
  const extensions = pathExtEnv ? ["", ...pathExtEnv.split(";").filter(Boolean)] : [""];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = joinPath(dir, `${command}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  if (!isRegularFile(path)) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readNodeEntrypointPath(config: unknown): string | undefined {
  if (!isRecord(config)) return undefined;
  const cmd = readCommandPath(config);
  if (!cmd) return undefined;
  // For `node script.js` style invocations the entrypoint script is
  // the real surface — fold it into the hash so a swapped script
  // (same node binary) still trips the pin.
  if (!/(^|\/)(?:node|deno|bun|python|python3)$/u.test(cmd)) return undefined;
  const args = isRecord(config) ? config.args : undefined;
  if (!Array.isArray(args)) return undefined;
  const first = args.find((value: unknown) => typeof value === "string" && !value.startsWith("-"));
  return typeof first === "string" ? first : undefined;
}

function isDeadConnection(connection: McpConnection | undefined): boolean {
  return connection?.connected === false;
}

function formatDisconnectError(name: string, disconnectReason?: string, reconnectError?: string): string {
  const head = `MCP server '${name}' disconnected${disconnectReason ? `: ${disconnectReason}` : ""}`;
  return reconnectError ? `${head}; reconnect failed: ${reconnectError}` : head;
}

async function closeConnectionQuietly(connection: McpConnection): Promise<void> {
  try {
    await connection.close?.();
  } catch {
    // Best-effort cleanup after failed MCP health checks.
  }
}

function auditReason(reasons: readonly string[]): string {
  return `Static security audit failed: ${reasons.join("; ")}`;
}

export function computeNextReconnectAt(policy: McpReconnectPolicy, nowMs: number, attempts: number): Date | undefined {
  if (!policy.enabled || attempts > policy.maxAttempts) {
    return undefined;
  }

  const delay = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * (2 ** Math.max(0, attempts - 1))
  );

  return new Date(nowMs + delay);
}

/**
 * Is an on-demand reconnect allowed right now, or would it retry-storm a
 * server that's already backing off / has given up? A fresh crash (no
 * backoff armed yet) is allowed; inside the backoff window it waits; once
 * maxAttempts is exhausted (`nextReconnectAt` cleared while attempts > 0)
 * it stays terminal.
 */
export function isOnDemandReconnectAllowed(health: McpHealthSnapshot | undefined, nowMs: number): boolean {
  const nextReconnectAt = health?.nextReconnectAt;
  if (nextReconnectAt) {
    return nextReconnectAt.getTime() <= nowMs;
  }
  return (health?.reconnectAttempts ?? 0) === 0;
}

export function summarizePreflightChecks(
  checks: readonly McpPreflightCheck[]
): { failCount: number; passCount: number; warnCount: number } {
  return {
    failCount: checks.filter((check) => check.status === "fail").length,
    passCount: checks.filter((check) => check.status === "pass").length,
    warnCount: checks.filter((check) => check.status === "warn").length
  };
}

/**
 * `muse` / `muse.<x>` are Muse's own loopback tool namespaces. An external MCP
 * server may not claim them — tool names are projected as
 * `${serverName}.${toolName}`, so such a server's output would be classified
 * first-party by the injection-provenance gate.
 */
export function isReservedServerName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "muse" || normalized.startsWith("muse.");
}
