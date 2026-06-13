/**
 * In-memory `McpServerStore` + `McpSecurityPolicyStore`
 * implementations, the `McpSecurityPolicyProvider` policy
 * resolver, normalizer helpers, and the two `McpRegistryError` /
 * `McpConnectionError` exception classes. All callable via the
 * public `@muse/mcp` re-exports — this file is the leaf, the
 * package barrel just forwards.
 *
 * Lives separately so `./index.ts` can stay focused on the type
 * surface + the wide re-export table. Kysely-backed stores remain
 * in `./server-stores.ts` (their own concerns). Manager + transport
 * implementations stay in `./manager.ts` + `./transport.ts`.
 */

import { createRunId } from "@muse/shared";

import type {
  McpReconnectPolicy,
  McpSecurityPolicy,
  McpSecurityPolicyInput,
  McpSecurityPolicyStore,
  McpServer,
  McpServerInput,
  McpServerStore,
  InMemoryMcpServerStoreOptions,
  InMemoryMcpSecurityPolicyStoreOptions
} from "./index.js";

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

export class McpRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRegistryError";
  }
}

/**
 * Classify the HTTP status behind an MCP connect/list failure as
 * retryable, mirroring `isRetryableNotesStatus` and architecture.md's
 * rule: 4xx (bad/expired token, server-not-found) is a PERMANENT
 * failure and MUST fail fast — retrying an external MCP server with a
 * credential that will never work just hammers it. 5xx + 429 are
 * transient and may retry. A bare network error carries no status
 * (`undefined`) and is treated as transient.
 */
export function isRetryableMcpConnectStatus(status: number | undefined): boolean {
  if (status === undefined || !Number.isFinite(status)) return true;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

export class McpConnectionError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "McpConnectionError";
    if (status !== undefined) {
      this.status = status;
    }
    this.retryable = isRetryableMcpConnectStatus(status);
  }
}

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

function compareServers(left: McpServer, right: McpServer): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.name.localeCompare(right.name);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}
