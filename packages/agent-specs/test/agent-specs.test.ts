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
