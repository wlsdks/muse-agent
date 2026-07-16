import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { McpRegistryError } from "../src/index.js";
import { KyselyMcpServerStore } from "../src/server-stores.js";

describe("KyselyMcpServerStore", () => {
  it("normalizes PostgreSQL duplicate-name failures to the registry conflict contract", async () => {
    const store = new KyselyMcpServerStore(createInsertDb({ code: "23505" }));

    await expect(store.save(serverInput())).rejects.toThrow(McpRegistryError);
    await expect(store.save(serverInput())).rejects.toThrow("MCP server already exists: local-tools");
  });

  it("preserves non-unique database failures", async () => {
    const failure = new Error("database unavailable");
    const store = new KyselyMcpServerStore(createInsertDb(failure));

    await expect(store.save(serverInput())).rejects.toBe(failure);
  });
});

function createInsertDb(failure: unknown): Kysely<MuseDatabase> {
  return {
    insertInto: () => ({
      values: () => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => Promise.reject(failure)
        })
      })
    })
  } as unknown as Kysely<MuseDatabase>;
}

function serverInput() {
  return {
    name: "local-tools",
    transportType: "stdio" as const
  };
}
