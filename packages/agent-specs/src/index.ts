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

/**
 * Two enabled workers seeded into a fresh in-memory registry so
 * `orchestrate` works out of the box instead of failing with
 * `NoAgentWorkerError`. `keywords: []` is deliberate: it keeps them
 * OUT of single-agent routing (`scoreAgentSpec` returns undefined for
 * an empty-keyword spec), so they act purely as orchestration workers.
 * No tools — pure reasoning keeps local-model tool-selection clean.
 */
export const DEFAULT_AGENT_SPECS: readonly AgentSpecInput[] = [
  {
    // Fixed createdAt earlier than the Critic so the sequential pipeline
    // runs Generalist (answer) before Critic (refine) — orchestration
    // auto-selection orders by creation time.
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    description: "Default general-purpose worker: answers the request directly and completely.",
    enabled: true,
    id: "default-generalist",
    independentExecution: true,
    keywords: [],
    mode: "standard",
    name: "Generalist",
    systemPrompt:
      "You are a capable generalist assistant. Answer the user's request directly, "
      + "completely, and concisely. Do not defer or ask for clarification unless the "
      + "request is genuinely ambiguous.",
    toolNames: []
  },
  {
    createdAt: new Date("2026-01-01T00:00:01.000Z"),
    description: "Default risk-lens worker: adds the risks, edge cases, and gaps the direct answer missed.",
    enabled: true,
    id: "default-critic",
    independentExecution: true,
    keywords: [],
    mode: "standard",
    name: "Critic",
    // A small local model won't reliably REWRITE a good draft, so instead of
    // asking it to "sharpen" (which just echoed the draft), give it a DISTINCT
    // generative job — surface what the first answer left out. This adds a
    // genuinely different second perspective in the sequential pipeline.
    systemPrompt:
      "A prior worker's direct answer is given to you in a system message beginning "
      + "\"Worker '...' completed:\". Do NOT repeat or restate it. Instead add what it MISSED: "
      + "the key risks, edge cases, caveats, and gaps. Reply with a short bulleted list titled "
      + "\"Risks & gaps:\" — only the additions, not the original answer.",
    toolNames: []
  }
];

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
    const maxEntries = options.maxEntries ?? InMemoryAgentSpecRegistry.defaultMaxEntries;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    this.maxEntries = maxEntries;
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

  const matchedKeywords = spec.keywords.filter((keyword) => {
    // An empty / whitespace keyword normalizes to "" and
    // `text.includes("")` is always true — a single junk keyword
    // (a store/legacy row the normalize path didn't sanitize)
    // would otherwise make this spec match every task.
    const needle = normalizeText(keyword);
    return needle.length > 0 && normalizedText.includes(needle);
  });

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

export type AgentCapabilityKind = "tool" | "persona";

export interface AgentCapability {
  readonly name: string;
  readonly description: string;
  readonly kind: AgentCapabilityKind;
  readonly inputSchema?: Record<string, unknown> | null;
}

export interface AgentCard {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: readonly AgentCapability[];
  readonly supportedInputFormats: readonly string[];
  readonly supportedOutputFormats: readonly string[];
}

export interface AgentCardToolInput {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown> | null;
}

export interface BuildAgentCardOptions {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly specs?: readonly AgentSpec[];
  readonly tools?: readonly AgentCardToolInput[];
  readonly supportedInputFormats?: readonly string[];
  readonly supportedOutputFormats?: readonly string[];
}

export const AGENT_CARD_DEFAULT_NAME = "muse";
export const AGENT_CARD_DEFAULT_VERSION = "1.0.0";
export const AGENT_CARD_DEFAULT_DESCRIPTION = "Muse provider-neutral AI conductor";
export const AGENT_CARD_DEFAULT_INPUT_FORMATS: readonly string[] = Object.freeze(["text", "json"]);
export const AGENT_CARD_DEFAULT_OUTPUT_FORMATS: readonly string[] = Object.freeze(["text", "json", "yaml"]);

/**
 * Build an A2A `AgentCard` from the active toolset and agent specs.
 *
 * Tool capabilities (kind: "tool") come from the `tools` argument with their
 * real `inputSchema` so external agents can call them with confidence. Persona
 * capabilities (kind: "persona") come from enabled agent specs and surface
 * their description as the discovery text. Duplicate tool names are
 * deduplicated; the first occurrence wins so the order of `tools` is the
 * priority list.
 *
 * Mirrors Reactor's `AgentCardProvider` semantics while staying provider-
 * neutral: no Spring AI / Atlassian coupling.
 */
export function buildAgentCard(options: BuildAgentCardOptions = {}): AgentCard {
  const seenTools = new Map<string, AgentCapability>();
  for (const tool of options.tools ?? []) {
    if (seenTools.has(tool.name)) {
      continue;
    }
    seenTools.set(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema ?? null,
      kind: "tool",
      name: tool.name
    });
  }
  const personas: AgentCapability[] = [];
  const seenPersonas = new Set<string>();
  for (const spec of options.specs ?? []) {
    if (!spec) {
      continue;
    }
    const name = `persona:${spec.name}`;
    if (seenPersonas.has(name)) {
      continue;
    }
    seenPersonas.add(name);
    personas.push({
      description: spec.description?.length ? spec.description : spec.name,
      inputSchema: null,
      kind: "persona",
      name
    });
  }
  return {
    capabilities: [...seenTools.values(), ...personas],
    description: options.description ?? AGENT_CARD_DEFAULT_DESCRIPTION,
    name: options.name ?? AGENT_CARD_DEFAULT_NAME,
    supportedInputFormats: options.supportedInputFormats ?? AGENT_CARD_DEFAULT_INPUT_FORMATS,
    supportedOutputFormats: options.supportedOutputFormats ?? AGENT_CARD_DEFAULT_OUTPUT_FORMATS,
    version: options.version ?? AGENT_CARD_DEFAULT_VERSION
  };
}
