import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryUserMemoryStore } from "@muse/memory";
import { LocalDirNotesProvider } from "@muse/domain-tools";
import { readPendingApprovals, recordPendingApproval, type PendingApproval } from "@muse/messaging";
import type { ModelProvider } from "@muse/model";
import type { MuseToolContext } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMcpServeTools, type McpServeDependencies } from "./mcp-serve-tools.js";

const context: MuseToolContext = { runId: "test-run" };

function baseDeps(overrides: Partial<McpServeDependencies> = {}, notesDir: string): McpServeDependencies {
  return {
    answerModel: undefined,
    answerTemperature: 0.6,
    embedFn: async () => {
      throw new Error("ECONNREFUSED — no local Ollama in this test");
    },
    embedModel: "nomic-embed-text-v2-moe",
    modelProvider: undefined,
    newId: () => "fixed-id",
    notesDir,
    notesIndexFile: join(notesDir, "..", "notes-index.json"),
    notesProvider: new LocalDirNotesProvider({ notesDir }),
    now: () => new Date("2026-07-07T00:00:00.000Z"),
    stagePendingApproval: async () => {
      throw new Error("stagePendingApproval not wired in this test's baseDeps — override it explicitly");
    },
    userId: "test-user",
    userMemoryStore: new InMemoryUserMemoryStore(),
    ...overrides
  };
}

describe("buildMcpServeTools", () => {
  let notesDir: string;

  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), "muse-mcp-serve-tools-"));
  });

  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true });
  });

  it("exposes exactly the 3 read-only tools plus the 1 write-proxy tool, with required args declared", () => {
    const tools = buildMcpServeTools(baseDeps({}, notesDir));
    expect(tools).toHaveLength(4);
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool] as const));
    expect([...byName.keys()].sort()).toEqual(["knowledge_search", "muse_recall", "propose_action", "user_model_read"]);
    expect(byName.get("muse_recall")?.definition.inputSchema.required).toEqual(["question"]);
    expect(byName.get("knowledge_search")?.definition.inputSchema.required).toEqual(["query"]);
    expect(byName.get("propose_action")?.definition.inputSchema.required).toEqual(["action", "draft"]);
    expect(byName.get("propose_action")?.definition.risk).toBe("write");
    for (const tool of tools) {
      if (tool.definition.name !== "propose_action") {
        expect(tool.definition.risk).toBe("read");
      }
      expect(tool.definition.description).toMatch(/use when/iu);
      expect(tool.definition.description).toMatch(/do not use|never use/iu);
    }
  });

  describe("knowledge_search", () => {
    it("returns source-tagged snippets for a seeded note even with the embedder unreachable (lexical fallback)", async () => {
      writeFileSync(join(notesDir, "embedder.md"), "We decided to use nomic-embed-text-v2-moe as the embedder model.\n");
      const tools = buildMcpServeTools(baseDeps({}, notesDir));
      const knowledgeSearch = tools.find((tool) => tool.definition.name === "knowledge_search")!;

      const result = await knowledgeSearch.execute({ query: "embedder model" }, context);
      expect(typeof result).toBe("string");
      expect(result as string).toContain("notes/embedder.md");
      expect(result as string).toContain("nomic-embed-text-v2-moe");
    });

    it("folds in the user's remembered facts, tagged with a memory/ source", async () => {
      const userMemoryStore = new InMemoryUserMemoryStore();
      userMemoryStore.upsertFact("test-user", "favorite_editor", "neovim");
      const tools = buildMcpServeTools(baseDeps({ userMemoryStore }, notesDir));
      const knowledgeSearch = tools.find((tool) => tool.definition.name === "knowledge_search")!;

      const result = await knowledgeSearch.execute({ query: "favorite editor" }, context);
      expect(result as string).toContain("memory/favorite_editor");
      expect(result as string).toContain("neovim");
    });

    it("clamps an out-of-range limit instead of throwing", async () => {
      writeFileSync(join(notesDir, "a.md"), "alpha note about coffee\n");
      const tools = buildMcpServeTools(baseDeps({}, notesDir));
      const knowledgeSearch = tools.find((tool) => tool.definition.name === "knowledge_search")!;
      await expect(knowledgeSearch.execute({ limit: 999, query: "coffee" }, context)).resolves.toBeTypeOf("string");
    });
  });

  describe("muse_recall", () => {
    it("returns a structured error (never an uncited answer) when no local model is configured", async () => {
      const tools = buildMcpServeTools(baseDeps({ answerModel: undefined, modelProvider: undefined }, notesDir));
      const museRecall = tools.find((tool) => tool.definition.name === "muse_recall")!;
      await expect(museRecall.execute({ question: "what embedder do I use?" }, context))
        .rejects.toThrow(/requires a configured local model/iu);
    });

    it("returns a structured error (never an uncited answer) when the local model is unreachable", async () => {
      const failingProvider = {
        generate: async () => {
          throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:11434");
        }
      } as unknown as ModelProvider;
      const tools = buildMcpServeTools(baseDeps({ answerModel: "ollama/gemma4:12b", modelProvider: failingProvider }, notesDir));
      const museRecall = tools.find((tool) => tool.definition.name === "muse_recall")!;
      await expect(museRecall.execute({ question: "what embedder do I use?" }, context))
        .rejects.toThrow(/local model unreachable/iu);
    });
  });

  describe("user_model_read", () => {
    async function seededDeps(): Promise<McpServeDependencies> {
      const userMemoryStore = new InMemoryUserMemoryStore();
      userMemoryStore.upsertFact("test-user", "home_city", "Seoul");
      userMemoryStore.upsertPreference("test-user", "tone", "concise replies");
      userMemoryStore.upsertPreference("test-user", "veto:food", "no eggs");
      userMemoryStore.upsertPreference("test-user", "goal:ship", "ship muse v1");
      await Promise.resolve(userMemoryStore.upsertUserModelSlot("test-user", {
        confidence: 0.9,
        id: "quiet_mornings",
        kind: "preference",
        updatedAt: new Date("2026-06-07T00:00:00.000Z"), // 30 days before the fixed `now`
        value: "prefers quiet mornings"
      }));
      return baseDeps({ userMemoryStore }, notesDir);
    }

    it("returns facts as asserted, confidence 1", async () => {
      const tools = buildMcpServeTools(await seededDeps());
      const userModelRead = tools.find((tool) => tool.definition.name === "user_model_read")!;
      const result = await userModelRead.execute({ kind: "facts" }, context) as unknown as { facts: readonly Record<string, unknown>[] };
      expect(result.facts).toEqual([{ asserted: true, confidence: 1, key: "home_city", value: "Seoul" }]);
    });

    it("returns preferences merging legacy (asserted) + typed (decayed) slots, excluding veto:/goal: keys", async () => {
      const tools = buildMcpServeTools(await seededDeps());
      const userModelRead = tools.find((tool) => tool.definition.name === "user_model_read")!;
      const result = await userModelRead.execute({ kind: "preferences" }, context) as unknown as { preferences: readonly Record<string, unknown>[] };

      const byKey = new Map(result.preferences.map((entry) => [entry.key, entry]));
      expect(byKey.has("veto:food")).toBe(false);
      expect(byKey.has("goal:ship")).toBe(false);
      expect(byKey.get("tone")).toEqual({ asserted: true, confidence: 1, key: "tone", value: "concise replies" });

      const quietMornings = byKey.get("quiet_mornings") as { asserted: boolean; confidence: number };
      expect(quietMornings.asserted).toBe(false);
      // effectiveConfidence(0.9, +30 days, halfLife 30) = 0.9 * 2^(-1) = 0.45
      expect(quietMornings.confidence).toBeCloseTo(0.45, 5);
    });

    it("returns both slices for kind 'all' (and 'all' is the default when kind is omitted)", async () => {
      const tools = buildMcpServeTools(await seededDeps());
      const userModelRead = tools.find((tool) => tool.definition.name === "user_model_read")!;
      const explicit = await userModelRead.execute({ kind: "all" }, context) as unknown as { facts: unknown[]; preferences: unknown[] };
      const omitted = await userModelRead.execute({}, context) as unknown as { facts: unknown[]; preferences: unknown[] };
      expect(explicit.facts).toHaveLength(1);
      expect(explicit.preferences.length).toBeGreaterThan(0);
      expect(omitted).toEqual(explicit);
    });

    it("rejects an invalid kind rather than silently defaulting", async () => {
      const tools = buildMcpServeTools(await seededDeps());
      const userModelRead = tools.find((tool) => tool.definition.name === "user_model_read")!;
      await expect(userModelRead.execute({ kind: "vetoes" }, context)).rejects.toThrow(/must be one of/iu);
    });

    it("never returns anything after the user forgets it", async () => {
      const userMemoryStore = new InMemoryUserMemoryStore();
      userMemoryStore.upsertFact("test-user", "temp_fact", "will be forgotten");
      userMemoryStore.forget("test-user", "temp_fact");
      const tools = buildMcpServeTools(baseDeps({ userMemoryStore }, notesDir));
      const userModelRead = tools.find((tool) => tool.definition.name === "user_model_read")!;
      const result = await userModelRead.execute({ kind: "facts" }, context) as unknown as { facts: unknown[] };
      expect(result.facts).toEqual([]);
    });
  });

  describe("propose_action", () => {
    it("stages via the REAL pending-approval store and executes NOTHING else (round-trips, notesDir untouched)", async () => {
      const approvalsDir = mkdtempSync(join(tmpdir(), "muse-mcp-serve-approvals-"));
      const approvalsFile = join(approvalsDir, "pending-approvals.json");
      const fixedNow = new Date("2026-07-07T00:00:00.000Z");
      const tools = buildMcpServeTools(baseDeps({
        newId: () => "fixed-id-1",
        now: () => fixedNow,
        stagePendingApproval: (entry) => recordPendingApproval(approvalsFile, entry)
      }, notesDir));
      const proposeAction = tools.find((tool) => tool.definition.name === "propose_action")!;

      try {
        const result = await proposeAction.execute(
          { action: "add_reminder", arguments: { at: "15:00" }, draft: "Remind me to call the dentist at 3pm" },
          context
        ) as unknown as { staged: boolean; id: string; message: string };

        expect(result.staged).toBe(true);
        expect(result.id).toBe("fixed-id-1");
        expect(result.message).toMatch(/muse approvals/iu);

        const pending = await readPendingApprovals(approvalsFile);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          arguments: { at: "15:00" },
          draft: "Remind me to call the dentist at 3pm",
          id: "fixed-id-1",
          providerId: "mcp",
          risk: "write",
          source: "mcp-serve",
          tool: "add_reminder"
        });

        // No external effect beyond the pending-approvals file: the notes dir
        // (a totally separate store propose_action has no handle on) is untouched.
        expect(readdirSync(notesDir)).toEqual([]);
      } finally {
        rmSync(approvalsDir, { recursive: true, force: true });
      }
    });

    it("builds the exact PendingApproval entry (id/createdAt/expiresAt) via a fake stager", async () => {
      const fixedNow = new Date("2026-07-07T00:00:00.000Z");
      const captured: PendingApproval[] = [];
      const tools = buildMcpServeTools(baseDeps({
        newId: () => "fixed-id-2",
        now: () => fixedNow,
        stagePendingApproval: async (entry) => {
          captured.push(entry);
        }
      }, notesDir));
      const proposeAction = tools.find((tool) => tool.definition.name === "propose_action")!;

      await proposeAction.execute({ action: "send_message", draft: "Tell Alex the meeting moved to 4pm" }, context);

      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual({
        arguments: {},
        createdAt: "2026-07-07T00:00:00.000Z",
        draft: "Tell Alex the meeting moved to 4pm",
        expiresAt: new Date(fixedNow.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        id: "fixed-id-2",
        providerId: "mcp",
        risk: "write",
        source: "mcp-serve",
        tool: "send_message",
        userId: "test-user"
      });
    });

    it("fails closed on blank action/draft — never stages anything", async () => {
      let staged = false;
      const tools = buildMcpServeTools(baseDeps({
        stagePendingApproval: async () => {
          staged = true;
        }
      }, notesDir));
      const proposeAction = tools.find((tool) => tool.definition.name === "propose_action")!;

      await expect(proposeAction.execute({ action: "", draft: "some draft" }, context)).rejects.toThrow(/non-empty/iu);
      await expect(proposeAction.execute({ action: "add_reminder" }, context)).rejects.toThrow(/non-empty/iu);
      expect(staged).toBe(false);
    });

    it("propagates a stage failure — never reports staged:true when the store write failed", async () => {
      const tools = buildMcpServeTools(baseDeps({
        stagePendingApproval: async () => {
          throw new Error("disk full");
        }
      }, notesDir));
      const proposeAction = tools.find((tool) => tool.definition.name === "propose_action")!;

      await expect(proposeAction.execute({ action: "add_reminder", draft: "some draft" }, context)).rejects.toThrow(/disk full/iu);
    });
  });
});
