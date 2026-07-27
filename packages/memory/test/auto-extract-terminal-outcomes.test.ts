import type { ModelProvider, ModelResponse } from "@muse/model";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FileUserMemoryAutoExtractOutcomeStore,
  createUserMemoryAutoExtractHook,
  readUserMemoryAutoExtractOutcomes,
  type UserMemoryAutoExtractOutcome,
  type UserMemoryAutoExtractReason
} from "../src/index.js";
import { InMemoryUserMemoryStore } from "../src/memory-user-store.js";

const validEmptyPayload = JSON.stringify({
  facts: {},
  goals: [],
  preferences: {},
  vetoes: []
});

function provider(generate: ModelProvider["generate"]): ModelProvider {
  return {
    generate,
    id: "terminal-outcome-test",
    async listModels() {
      return [];
    },
    async *stream() {
      // The auto-extract hook only calls generate().
    }
  };
}

function response(output: string): ModelResponse {
  return { id: "assistant-response", model: "test", output };
}

async function runForReason(
  reason: UserMemoryAutoExtractReason,
  options: {
    readonly extractionTimeoutMs?: number;
    readonly modelProvider: ModelProvider;
    readonly onLearned?: () => void;
    readonly store?: InMemoryUserMemoryStore;
    readonly userText?: string;
    readonly assistantText?: string;
  }
): Promise<readonly UserMemoryAutoExtractOutcome[]> {
  const outcomes: UserMemoryAutoExtractOutcome[] = [];
  const hook = createUserMemoryAutoExtractHook({
    extractionCooldownMs: 0,
    extractionTimeoutMs: options.extractionTimeoutMs,
    model: "test",
    modelProvider: options.modelProvider,
    ...(options.onLearned ? { onLearned: options.onLearned } : {}),
    onOutcome: async (outcome) => {
      outcomes.push(outcome);
    },
    store: options.store ?? new InMemoryUserMemoryStore()
  });

  await expect(hook.afterComplete?.(
    {
      input: {
        messages: [{ content: options.userText ?? "I like tea", role: "user" }],
        metadata: { userId: "owner" }
      },
      runId: `run-${reason}`
    },
    response(options.assistantText ?? "Noted.")
  )).resolves.toBeUndefined();

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    reason,
    runId: `run-${reason}`,
    schemaVersion: 1
  });
  expect(Number.isNaN(Date.parse(outcomes[0]!.recordedAt))).toBe(false);
  return outcomes;
}

describe("user-memory auto-extract terminal outcomes", () => {
  it("records learned after a grounded value is stored", async () => {
    await runForReason("learned", {
      modelProvider: provider(async () => response(JSON.stringify({
        facts: { home_city: "Seoul" },
        goals: [],
        preferences: {},
        vetoes: []
      }))),
      userText: "My home city is Seoul"
    });
  });

  it("records nothing_new for a valid empty extraction", async () => {
    await runForReason("nothing_new", {
      modelProvider: provider(async () => response(validEmptyPayload))
    });
  });

  it("records policy_rejected when model-only material is filtered", async () => {
    await runForReason("policy_rejected", {
      assistantText: "The MTU is 1420.",
      modelProvider: provider(async () => response(JSON.stringify({
        facts: { mtu: "1420" },
        goals: [],
        preferences: {},
        vetoes: []
      }))),
      userText: "Please answer the networking question"
    });
  });

  it("records model_error when generation throws", async () => {
    await runForReason("model_error", {
      modelProvider: provider(async () => {
        throw new Error("provider unavailable");
      })
    });
  });

  it.each([
    ["unparseable output", "not-json"],
    ["parseable output missing required fields", "{}"]
  ])("records schema_error for %s", async (_label, output) => {
    await runForReason("schema_error", {
      modelProvider: provider(async () => response(output))
    });
  });

  it("records store_error when a grounded write fails", async () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact = () => {
      throw new Error("disk full");
    };
    await runForReason("store_error", {
      modelProvider: provider(async () => response(JSON.stringify({
        facts: { home_city: "Seoul" },
        goals: [],
        preferences: {},
        vetoes: []
      }))),
      store,
      userText: "My home city is Seoul"
    });
  });

  it("records partial store failure as store_error while preserving salvageable writes", async () => {
    const store = new InMemoryUserMemoryStore();
    const upsertFact = store.upsertFact.bind(store);
    store.upsertFact = (userId, key, value) => {
      if (key === "home_city") throw new Error("one key failed");
      return upsertFact(userId, key, value);
    };
    await runForReason("store_error", {
      modelProvider: provider(async () => response(JSON.stringify({
        facts: { favorite_drink: "tea", home_city: "Seoul" },
        goals: [],
        preferences: {},
        vetoes: []
      }))),
      store,
      userText: "My home city is Seoul and my favorite drink is tea"
    });
    expect(store.findByUserId("owner")?.facts).toEqual({ favorite_drink: "tea" });
  });

  it("does not report learned when the initial store read fails but a write succeeds", async () => {
    const store = new InMemoryUserMemoryStore();
    const findByUserId = store.findByUserId.bind(store);
    let firstRead = true;
    store.findByUserId = (userId) => {
      if (firstRead) {
        firstRead = false;
        throw new Error("read failed");
      }
      return findByUserId(userId);
    };
    await runForReason("store_error", {
      modelProvider: provider(async () => response(JSON.stringify({
        facts: { home_city: "Seoul" },
        goals: [],
        preferences: {},
        vetoes: []
      }))),
      store,
      userText: "My home city is Seoul"
    });
    expect(store.findByUserId("owner")?.facts.home_city).toBe("Seoul");
  });

  it("records store_error when the optional onLearned snapshot read fails", async () => {
    const store = new InMemoryUserMemoryStore();
    const findByUserId = store.findByUserId.bind(store);
    let firstRead = true;
    store.findByUserId = (userId) => {
      if (firstRead) {
        firstRead = false;
        throw new Error("history snapshot read failed");
      }
      return findByUserId(userId);
    };
    await runForReason("store_error", {
      modelProvider: provider(async () => response(JSON.stringify({
        facts: { home_city: "Seoul" },
        goals: [],
        preferences: {},
        vetoes: []
      }))),
      onLearned: () => undefined,
      store,
      userText: "My home city is Seoul"
    });
    expect(store.findByUserId("owner")?.facts.home_city).toBe("Seoul");
  });

  it("records timeout when generation does not settle", async () => {
    await runForReason("timeout", {
      extractionTimeoutMs: 100,
      modelProvider: provider(() => new Promise<ModelResponse>(() => undefined))
    });
  });

  it("keeps the conversation fail-open when the outcome recorder itself fails", async () => {
    const hook = createUserMemoryAutoExtractHook({
      extractionCooldownMs: 0,
      model: "test",
      modelProvider: provider(async () => response(validEmptyPayload)),
      onOutcome: async () => {
        throw new Error("diagnostic store unavailable");
      },
      store: new InMemoryUserMemoryStore()
    });

    await expect(hook.afterComplete?.(
      {
        input: {
          messages: [{ content: "I like tea", role: "user" }],
          metadata: { userId: "owner" }
        },
        runId: "run-recorder-error"
      },
      response("Noted.")
    )).resolves.toBeUndefined();
  });

  it("stops waiting for a never-settling outcome recorder", async () => {
    const hook = createUserMemoryAutoExtractHook({
      extractionCooldownMs: 0,
      model: "test",
      modelProvider: provider(async () => response(validEmptyPayload)),
      onOutcome: () => new Promise<void>(() => undefined),
      outcomeRecordingTimeoutMs: 10,
      store: new InMemoryUserMemoryStore()
    });

    const started = Date.now();
    await expect(hook.afterComplete?.(
      {
        input: {
          messages: [{ content: "I like tea", role: "user" }],
          metadata: { userId: "owner" }
        },
        runId: "run-hanging-recorder"
      },
      response("Noted.")
    )).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("persists only bounded metadata, never prompt, answer, or extracted values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-auto-extract-outcomes-"));
    const file = join(dir, "outcomes.json");
    const store = new FileUserMemoryAutoExtractOutcomeStore({ file, maxEntries: 2 });
    for (const [index, reason] of ["learned", "store_error", "nothing_new"].entries()) {
      await store.record({
        reason: reason as UserMemoryAutoExtractReason,
        recordedAt: new Date(Date.UTC(2026, 6, 27, 12, index)).toISOString(),
        runId: `run-${index.toString()}`,
        schemaVersion: 1
      });
    }

    expect(await readUserMemoryAutoExtractOutcomes(file)).toEqual([
      expect.objectContaining({ reason: "store_error", runIdHash: expect.stringMatching(/^[a-f0-9]{32}$/u) }),
      expect.objectContaining({ reason: "nothing_new", runIdHash: expect.stringMatching(/^[a-f0-9]{32}$/u) })
    ]);
    const bytes = await readFile(file, "utf8");
    expect(bytes).not.toContain("I like tea");
    expect(bytes).not.toContain("Noted.");
    expect(bytes).not.toContain("Seoul");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("normalizes caller-supplied extras and oversized raw run ids out of the persisted schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-auto-extract-outcomes-extra-"));
    const file = join(dir, "outcomes.json");
    const store = new FileUserMemoryAutoExtractOutcomeStore({ file });
    const secretMarker = "SUPER_SECRET_PROMPT_VALUE";
    await store.record({
      answer: secretMarker,
      key: secretMarker,
      prompt: secretMarker,
      reason: "learned",
      recordedAt: "2026-07-27T12:00:00.000Z",
      runId: `${secretMarker}${"x".repeat(20_000)}`,
      schemaVersion: 1,
      userId: secretMarker,
      value: secretMarker
    } as UserMemoryAutoExtractOutcome);

    const bytes = await readFile(file, "utf8");
    expect(bytes).not.toContain(secretMarker);
    expect(bytes.length).toBeLessThan(512);
    expect(await readUserMemoryAutoExtractOutcomes(file)).toEqual([
      {
        reason: "learned",
        recordedAt: "2026-07-27T12:00:00.000Z",
        runIdHash: expect.stringMatching(/^[a-f0-9]{32}$/u),
        schemaVersion: 1
      }
    ]);
  });

  it("keeps real hook prompt/answer/value bytes out of the wired file outcome store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-auto-extract-outcomes-hook-"));
    const file = join(dir, "outcomes.json");
    const outcomeStore = new FileUserMemoryAutoExtractOutcomeStore({ file });
    const secretMarker = "PRIVATE_HOME_CITY_MARKER";
    const hook = createUserMemoryAutoExtractHook({
      extractionCooldownMs: 0,
      model: "test",
      modelProvider: provider(async () => response(JSON.stringify({
        facts: { home_city: secretMarker },
        goals: [],
        preferences: {},
        vetoes: []
      }))),
      onOutcome: (outcome) => outcomeStore.record(outcome),
      store: new InMemoryUserMemoryStore()
    });
    await hook.afterComplete?.(
      {
        input: {
          messages: [{ content: `My home city is ${secretMarker}`, role: "user" }],
          metadata: { userId: "owner" }
        },
        runId: "run-private-hook"
      },
      response(`I will remember ${secretMarker}.`)
    );

    const bytes = await readFile(file, "utf8");
    expect(bytes).not.toContain(secretMarker);
    expect(await readUserMemoryAutoExtractOutcomes(file)).toEqual([
      expect.objectContaining({ reason: "learned" })
    ]);
  });

  it("does not lose concurrent records from separate store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-auto-extract-outcomes-concurrent-"));
    const file = join(dir, "outcomes.json");
    const stores = [
      new FileUserMemoryAutoExtractOutcomeStore({ file, maxEntries: 64 }),
      new FileUserMemoryAutoExtractOutcomeStore({ file, maxEntries: 64 })
    ];
    await Promise.all(Array.from({ length: 32 }, async (_unused, index) => {
      await stores[index % stores.length]!.record({
        reason: index % 2 === 0 ? "learned" : "nothing_new",
        recordedAt: new Date(Date.UTC(2026, 6, 27, 12, index)).toISOString(),
        runId: `run-concurrent-${index.toString()}`,
        schemaVersion: 1
      });
    }));

    const outcomes = await readUserMemoryAutoExtractOutcomes(file);
    expect(outcomes).toHaveLength(32);
    expect(new Set(outcomes.map((outcome) => outcome.runIdHash)).size).toBe(32);
  });
});
