import { createRunId } from "@muse/shared";

export type Awaitable<T> = T | Promise<T>;
export type AgentSpecMode = "react" | "standard" | "plan_execute";

export interface AgentSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly toolNames: readonly string[];
  readonly keywords: readonly string[];
  readonly systemPrompt?: string;
  readonly mode: AgentSpecMode;
  readonly enabled: boolean;
  readonly independentExecution: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentSpecInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly toolNames?: readonly string[];
  readonly keywords?: readonly string[];
  readonly systemPrompt?: string | null;
  readonly mode?: AgentSpecMode;
  readonly enabled?: boolean;
  readonly independentExecution?: boolean;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface AgentSpecRegistry {
  list(): Awaitable<readonly AgentSpec[]>;
  listEnabled(): Awaitable<readonly AgentSpec[]>;
  getById(id: string): Awaitable<AgentSpec | undefined>;
  getByName(name: string): Awaitable<AgentSpec | undefined>;
  save(input: AgentSpecInput): Awaitable<AgentSpec>;
  deleteById(id: string): Awaitable<void>;
  deleteByName(name: string): Awaitable<void>;
}

export interface InMemoryAgentSpecRegistryOptions {
  readonly maxEntries?: number;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface AgentSpecResolution {
  readonly spec: AgentSpec;
  readonly confidence: number;
  readonly matchedKeywords: readonly string[];
}

export interface RuleBasedAgentSpecResolverOptions {
  readonly confidenceThreshold?: number;
}

export class InMemoryAgentSpecRegistry implements AgentSpecRegistry {
  static readonly defaultMaxEntries = 10_000;

  private readonly maxEntries: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly specsById = new Map<string, AgentSpec>();
  private readonly idByName = new Map<string, string>();

  constructor(specs: readonly AgentSpecInput[] = [], options: InMemoryAgentSpecRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? InMemoryAgentSpecRegistry.defaultMaxEntries;
    this.idFactory = options.idFactory ?? (() => createRunId("agent_spec"));
    this.now = options.now ?? (() => new Date());

    for (const spec of specs) {
      this.save(spec);
    }
  }

  list(): readonly AgentSpec[] {
    return [...this.specsById.values()].sort(compareAgentSpecs);
  }

  listEnabled(): readonly AgentSpec[] {
    return this.list().filter((spec) => spec.enabled);
  }

  getById(id: string): AgentSpec | undefined {
    return this.specsById.get(id);
  }

  getByName(name: string): AgentSpec | undefined {
    const id = this.idByName.get(name);
    return id ? this.getById(id) : undefined;
  }

  save(input: AgentSpecInput): AgentSpec {
    const existing = this.getByName(input.name) ?? (input.id ? this.getById(input.id) : undefined);
    const id = existing?.id ?? input.id ?? this.idFactory();
    const createdAt = existing?.createdAt ?? input.createdAt ?? this.now();
    const updatedAt = existing ? this.now() : input.updatedAt ?? createdAt;
    const spec = normalizeAgentSpecInput(input, {
      createdAt,
      id,
      updatedAt
    });

    if (existing && existing.name !== spec.name) {
      this.idByName.delete(existing.name);
    }

    this.specsById.set(spec.id, spec);
    this.idByName.set(spec.name, spec.id);
    this.evictOverflow();
    return spec;
  }

  deleteById(id: string): void {
    const existing = this.specsById.get(id);

    if (existing) {
      this.idByName.delete(existing.name);
    }

    this.specsById.delete(id);
  }

  deleteByName(name: string): void {
    const id = this.idByName.get(name);

    if (id) {
      this.deleteById(id);
    }
  }

  private evictOverflow(): void {
    while (this.specsById.size > this.maxEntries) {
      const oldest = [...this.specsById.values()].sort(
        (left, right) => left.updatedAt.getTime() - right.updatedAt.getTime()
      )[0];

      if (!oldest) {
        return;
      }

      this.deleteById(oldest.id);
    }
  }
}

export class RuleBasedAgentSpecResolver {
  private readonly confidenceThreshold: number;

  constructor(
    private readonly registry: AgentSpecRegistry,
    options: RuleBasedAgentSpecResolverOptions = {}
  ) {
    this.confidenceThreshold = options.confidenceThreshold ?? 0.6;
  }

  async resolve(text: string): Promise<AgentSpecResolution | undefined> {
    const normalizedText = normalizeText(text);
    const matches: AgentSpecResolution[] = [];

    for (const spec of await this.registry.listEnabled()) {
      const match = scoreAgentSpec(spec, normalizedText);

      if (match && match.confidence >= this.confidenceThreshold) {
        matches.push(match);
      }
    }

    return matches.sort(compareAgentSpecResolution)[0];
  }
}

export function normalizeAgentSpecInput(
  input: AgentSpecInput,
  identity: {
    readonly createdAt: Date;
    readonly id: string;
    readonly updatedAt: Date;
  }
): AgentSpec {
  return {
    createdAt: identity.createdAt,
    description: input.description ?? "",
    enabled: input.enabled ?? true,
    id: identity.id,
    independentExecution: input.independentExecution ?? true,
    keywords: uniqueStrings(input.keywords ?? []),
    mode: input.mode ?? "react",
    name: input.name,
    systemPrompt: input.systemPrompt ?? undefined,
    toolNames: uniqueStrings(input.toolNames ?? []),
    updatedAt: identity.updatedAt
  };
}

export function scoreAgentSpec(
  spec: AgentSpec,
  normalizedText: string
): AgentSpecResolution | undefined {
  if (spec.keywords.length === 0) {
    return undefined;
  }

  const matchedKeywords = spec.keywords.filter((keyword) => normalizedText.includes(normalizeText(keyword)));

  if (matchedKeywords.length === 0) {
    return undefined;
  }

  return {
    confidence: matchedKeywords.length / spec.keywords.length,
    matchedKeywords,
    spec
  };
}

function compareAgentSpecs(left: AgentSpec, right: AgentSpec): number {
  return left.name.localeCompare(right.name);
}

function compareAgentSpecResolution(left: AgentSpecResolution, right: AgentSpecResolution): number {
  return (
    right.confidence - left.confidence ||
    right.matchedKeywords.length - left.matchedKeywords.length ||
    left.spec.name.localeCompare(right.spec.name)
  );
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export { KyselyAgentSpecRegistry } from "./kysely-store.js";
export type { KyselyAgentSpecRegistryOptions } from "./kysely-store.js";
