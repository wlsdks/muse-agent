import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  AGENT_CARD_DEFAULT_INPUT_FORMATS,
  AGENT_CARD_DEFAULT_NAME,
  AGENT_CARD_DEFAULT_OUTPUT_FORMATS,
  AGENT_CARD_DEFAULT_VERSION,
  buildAgentCard,
  InMemoryAgentSpecRegistry,
  RuleBasedAgentSpecResolver,
  scoreAgentSpec
} from "../src/index.js";
import {
  buildAgentSpecUpsertQuery,
  createAgentSpecInsert,
  mapAgentSpecRow
} from "../src/kysely-store.js";

describe("InMemoryAgentSpecRegistry", () => {
  it("saves specs, preserves createdAt on update, and lists enabled specs by name", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-02T00:00:00.000Z");
    let now = createdAt;
    const registry = new InMemoryAgentSpecRegistry([], {
      idFactory: () => "spec-1",
      now: () => now
    });

    registry.save({
      keywords: ["write", "note", "write"],
      name: "writer",
      toolNames: ["create_file", "create_file"]
    });
    now = updatedAt;
    const saved = registry.save({
      enabled: false,
      name: "writer",
      toolNames: ["create_file", "update_file"]
    });

    expect(saved).toMatchObject({
      createdAt,
      enabled: false,
      id: "spec-1",
      name: "writer",
      toolNames: ["create_file", "update_file"],
      updatedAt
    });
    expect(registry.listEnabled()).toEqual([]);
  });

  it("evicts the oldest updated spec when bounded", () => {
    let nextMs = Date.parse("2026-01-01T00:00:00.000Z");
    const registry = new InMemoryAgentSpecRegistry([], {
      idFactory: sequentialIds("spec"),
      maxEntries: 1,
      now: () => new Date(nextMs++)
    });

    registry.save({ name: "first" });
    registry.save({ name: "second" });

    expect(registry.getByName("first")).toBeUndefined();
    expect(registry.getByName("second")?.id).toBe("spec-2");
  });

  it("rejects capacity values that would make saved specs immediately unreachable", () => {
    for (const maxEntries of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new InMemoryAgentSpecRegistry([], { maxEntries })).toThrow("maxEntries must be a positive safe integer");
    }
  });
});

describe("RuleBasedAgentSpecResolver", () => {
  it("resolves the best enabled spec when keyword confidence passes threshold", async () => {
    const registry = new InMemoryAgentSpecRegistry([
      {
        keywords: ["summarize", "brief"],
        name: "summarizer",
        toolNames: ["read_file"]
      },
      {
        keywords: ["deploy"],
        name: "disabled-deploy",
        enabled: false
      }
    ]);
    const resolver = new RuleBasedAgentSpecResolver(registry, { confidenceThreshold: 0.5 });

    await expect(resolver.resolve("Please summarize this brief")).resolves.toMatchObject({
      confidence: 1,
      matchedKeywords: ["summarize", "brief"],
      spec: {
        name: "summarizer",
        toolNames: ["read_file"]
      }
    });
    await expect(resolver.resolve("deploy this")).resolves.toBeUndefined();
  });

  it("does not resolve low confidence partial matches", async () => {
    const registry = new InMemoryAgentSpecRegistry([
      {
        keywords: ["create", "ticket", "status"],
        name: "ticketing"
      }
    ]);
    const resolver = new RuleBasedAgentSpecResolver(registry, { confidenceThreshold: 0.8 });

    await expect(resolver.resolve("create")).resolves.toBeUndefined();
  });

  it("scores agent specs without model calls", () => {
    const registry = new InMemoryAgentSpecRegistry([{ keywords: ["rag", "search"], name: "research" }]);
    const spec = registry.getByName("research");

    expect(spec ? scoreAgentSpec(spec, "rag pipeline") : undefined).toMatchObject({
      confidence: 0.5,
      matchedKeywords: ["rag"]
    });
  });

  it("an empty keyword (store/legacy row) does not make a spec match every task", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    // The load path (toStringArray) keeps "" — unlike the normalize
    // path's uniqueStrings — so this is the realistic vulnerable spec.
    const spec = mapAgentSpecRow({
      created_at: now,
      description: "",
      enabled: true,
      id: "spec-junk",
      independent_execution: true,
      keywords: ["", "billing"],
      mode: "react",
      name: "support",
      system_prompt: null,
      tool_names: [],
      updated_at: now
    } as unknown as Parameters<typeof mapAgentSpecRow>[0]);

    // Unrelated text: pre-fix the "" keyword matched everything.
    expect(scoreAgentSpec(spec, "totally unrelated request")).toBeUndefined();
    // A real keyword still matches; "" is NOT counted as a match.
    expect(scoreAgentSpec(spec, "a billing question")).toMatchObject({
      matchedKeywords: ["billing"]
    });
  });
});

describe("KyselyAgentSpecRegistry", () => {
  it("builds PostgreSQL upsert SQL for agent specs", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = buildAgentSpecUpsertQuery(
      db,
      {
        description: "Handles research tasks",
        keywords: ["research", "search"],
        mode: "react",
        name: "researcher",
        systemPrompt: "Use concise reasoning.",
        toolNames: ["web_search"]
      },
      { idFactory: () => "spec-1", now: () => now }
    );

    const compiled = query.compile();

    expect(compiled.sql).toContain('insert into "agent_specs"');
    expect(compiled.sql).toContain('on conflict ("name") do update');
    expect(compiled.sql).toContain("returning *");
    expect(compiled.parameters).toEqual([
      now,
      "Handles research tasks",
      true,
      "spec-1",
      true,
      ["research", "search"],
      "react",
      "researcher",
      "Use concise reasoning.",
      ["web_search"],
      now,
      "Handles research tasks",
      true,
      true,
      ["research", "search"],
      "react",
      "Use concise reasoning.",
      ["web_search"],
      now
    ]);
  });

  it("maps agent spec rows and insert payloads", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const insert = createAgentSpecInsert(
      {
        id: "spec-1",
        keywords: ["write", "note", "write"],
        name: "writer",
        systemPrompt: null,
        toolNames: ["write_file"]
      },
      { idFactory: () => "unused", now: () => now }
    );

    expect(insert).toMatchObject({
      created_at: now,
      enabled: true,
      id: "spec-1",
      independent_execution: true,
      keywords: ["write", "note"],
      mode: "react",
      name: "writer",
      system_prompt: null,
      tool_names: ["write_file"],
      updated_at: now
    });
    expect(mapAgentSpecRow(insert)).toEqual({
      createdAt: now,
      description: "",
      enabled: true,
      id: "spec-1",
      independentExecution: true,
      keywords: ["write", "note"],
      mode: "react",
      name: "writer",
      systemPrompt: undefined,
      toolNames: ["write_file"],
      updatedAt: now
    });
  });
});

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}

describe("buildAgentCard (A2A)", () => {
  it("emits the default identity when no overrides are passed", () => {
    const card = buildAgentCard({});
    expect(card.name).toBe(AGENT_CARD_DEFAULT_NAME);
    expect(card.version).toBe(AGENT_CARD_DEFAULT_VERSION);
    expect(card.supportedInputFormats).toEqual(AGENT_CARD_DEFAULT_INPUT_FORMATS);
    expect(card.supportedOutputFormats).toEqual(AGENT_CARD_DEFAULT_OUTPUT_FORMATS);
    expect(card.capabilities).toEqual([]);
  });

  it("includes tool capabilities with their real input schema", () => {
    const card = buildAgentCard({
      tools: [
        {
          description: "List items",
          inputSchema: { properties: { tag: { type: "string" } }, type: "object" },
          name: "list_items"
        }
      ]
    });
    expect(card.capabilities).toEqual([
      {
        description: "List items",
        inputSchema: { properties: { tag: { type: "string" } }, type: "object" },
        kind: "tool",
        name: "list_items"
      }
    ]);
  });

  it("dedupes tools by name keeping the first occurrence (priority order)", () => {
    const card = buildAgentCard({
      tools: [
        { description: "primary impl", name: "shared" },
        { description: "secondary impl", name: "shared" }
      ]
    });
    expect(card.capabilities).toHaveLength(1);
    expect(card.capabilities[0]?.description).toBe("primary impl");
  });

  it("appends agent specs as persona capabilities after the tools", () => {
    const card = buildAgentCard({
      specs: [
        {
          createdAt: new Date(0),
          description: "Plans complex changes",
          enabled: true,
          id: "planner",
          keywords: [],
          mode: "plan_execute",
          name: "planner",
          priority: 0,
          toolNames: [],
          updatedAt: new Date(0)
        }
      ],
      tools: [{ description: "Echo", name: "echo" }]
    });
    expect(card.capabilities.map((capability) => capability.name)).toEqual(["echo", "persona:planner"]);
    expect(card.capabilities[1]?.kind).toBe("persona");
    expect(card.capabilities[1]?.description).toBe("Plans complex changes");
  });

  it("dedupes duplicate persona names — first occurrence wins, matching the tools dedup semantic", () => {
    // A caller that merges specs from multiple sources (DB rows + a
    // config file + a runtime override) can hand the builder two
    // specs with the same name. Tools dedupe by name so a discovered
    // AgentCard surfaces each capability once; pre-fix the persona
    // path skipped that step and emitted `persona:calendar` twice
    // when two `calendar` specs were passed.
    const card = buildAgentCard({
      specs: [
        {
          createdAt: new Date(0),
          description: "primary calendar persona",
          enabled: true,
          id: "p1",
          keywords: [],
          mode: "react",
          name: "calendar",
          priority: 0,
          toolNames: [],
          updatedAt: new Date(0)
        },
        {
          createdAt: new Date(0),
          description: "duplicate calendar persona",
          enabled: true,
          id: "p2",
          keywords: [],
          mode: "react",
          name: "calendar",
          priority: 0,
          toolNames: [],
          updatedAt: new Date(0)
        }
      ]
    });
    const personas = card.capabilities.filter((capability) => capability.kind === "persona");
    expect(personas).toHaveLength(1);
    expect(personas[0]?.name).toBe("persona:calendar");
    expect(personas[0]?.description).toBe("primary calendar persona");
  });

  it("falls back to the spec name when description is empty", () => {
    const card = buildAgentCard({
      specs: [
        {
          createdAt: new Date(0),
          description: "",
          enabled: true,
          id: "p",
          keywords: [],
          mode: "react",
          name: "p",
          priority: 0,
          toolNames: [],
          updatedAt: new Date(0)
        }
      ]
    });
    expect(card.capabilities[0]?.description).toBe("p");
  });

  it("respects custom name / version / description / input-output formats", () => {
    const card = buildAgentCard({
      description: "Custom desc",
      name: "muse-pro",
      supportedInputFormats: ["text"],
      supportedOutputFormats: ["yaml"],
      version: "2.0.0"
    });
    expect(card).toMatchObject({
      description: "Custom desc",
      name: "muse-pro",
      supportedInputFormats: ["text"],
      supportedOutputFormats: ["yaml"],
      version: "2.0.0"
    });
  });
});
