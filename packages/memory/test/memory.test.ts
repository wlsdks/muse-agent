import { describe, expect, it, vi } from "vitest";
import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import {
  COMPACTION_PERSONA_SNAPSHOT_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_PINNED_ENTITIES_PREFIX,
  trimToolOutput,
  buildActiveTaskMemoryQuery,
  buildConversationSummaryUpsertQuery,
  buildTaskMemoryUpsertQuery,
  computeApproximateTokens,
  createConversationSummaryInsert,
  createUserMemoryAutoExtractHook,
  createUserMemoryInsert,
  createTaskMemoryInsert,
  createApproximateTokenEstimator,
  evaluateTaskMemoryQuality,
  estimateConversationTokens,
  InMemoryConversationSummaryStore,
  InMemoryTaskMemoryStore,
  InMemoryUserMemoryStore,
  mapConversationSummaryRow,
  mapTaskMemoryRow,
  mapUserMemoryRow,
  TaskMemoryQualityError,
  trimConversationMessages,
  type ConversationMessage,
  type TokenEstimator
} from "../src/index.js";

const lengthEstimator: TokenEstimator = {
  estimate: (text) => text.length
};

describe("approximate token estimator", () => {
  it("uses character-class heuristics and returns zero for empty text", () => {
    expect(computeApproximateTokens("")).toBe(0);
    expect(computeApproximateTokens("abcd")).toBe(1);
    expect(computeApproximateTokens("안녕")).toBe(1);
    expect(computeApproximateTokens("😀😀")).toBe(2);
  });

  it("caches repeated long text estimates behind a bounded hash key", () => {
    const estimator = createApproximateTokenEstimator({ cacheKeyMaxChars: 4, maxEntries: 2, ttlMs: 60_000 });
    const longText = "a".repeat(20);

    expect(estimator.estimate(longText)).toBe(estimator.estimate(longText));
  });

  it("expires cache entries by ttl", () => {
    vi.useFakeTimers();
    const estimator = createApproximateTokenEstimator({ ttlMs: 10 });

    expect(estimator.estimate("abcd")).toBe(1);
    vi.advanceTimersByTime(11);
    expect(estimator.estimate("abcd")).toBe(1);
    vi.useRealTimers();
  });
});

describe("conversation trimming", () => {
  it("keeps only the most recent user message when budget is non-positive", () => {
    const result = trimConversationMessages(
      [
        user("old"),
        assistant("answer"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 5,
        outputReserveTokens: 10,
        systemPrompt: "system"
      }
    );

    expect(result.messages).toEqual([user("latest")]);
    expect(result.removedCount).toBe(2);
  });

  it("keeps leading system memory while old history can satisfy the budget", () => {
    const result = trimConversationMessages(
      [
        system("facts"),
        system("summary"),
        user("old question"),
        assistant("old answer"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 75,
        outputReserveTokens: 0
      }
    );

    expect(result.messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
    expect(result.messages.at(-1)?.content).toBe("latest");
  });

  it("drops leading system memory before dropping fresh tool observations", () => {
    const result = trimConversationMessages(
      [
        system("memory-a"),
        system("memory-b"),
        user("keep"),
        assistantTool("search", { q: "status" }),
        tool("search result")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 97,
        outputReserveTokens: 0
      }
    );

    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(result.messages[0]?.content).toBe("keep");
  });

  it("removes assistant tool calls with their tool response as a pair", () => {
    const result = trimConversationMessages(
      [
        assistantTool("search", { q: "old" }),
        tool("old result"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 30,
        outputReserveTokens: 0
      }
    );

    expect(result.messages).toEqual([user("latest")]);
  });

  it("preserves multiple assistant tool responses as one intact exchange", () => {
    const messages = [
      user("keep"),
      assistantMultiTool(["search", "lookup"]),
      toolFor("call-search", "search result"),
      toolFor("call-lookup", "lookup result")
    ];
    const result = trimConversationMessages(messages, {
      estimator: lengthEstimator,
      maxContextWindowTokens: 200,
      outputReserveTokens: 0
    });

    expect(result.messages).toEqual(messages);
  });

  it("removes multi-tool assistant exchanges deterministically as a full group", () => {
    const messages = [
      assistantMultiTool(["search", "lookup"]),
      toolFor("call-search", "old search result ".repeat(5)),
      toolFor("call-lookup", "old lookup result ".repeat(5)),
      user("latest")
    ];
    const options = {
      estimator: lengthEstimator,
      insertSummary: false,
      maxContextWindowTokens: 30,
      outputReserveTokens: 0
    };
    const first = trimConversationMessages(messages, options);
    const second = trimConversationMessages(messages, options);

    expect(first.messages).toEqual([user("latest")]);
    expect(second).toEqual(first);
  });

  it("removes orphan tool responses after all trim phases", () => {
    const result = trimConversationMessages(
      [
        system("memory"),
        tool("orphan"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 100,
        outputReserveTokens: 0
      }
    );

    expect(result.messages.some((message) => message.role === "tool")).toBe(false);
    expect(result.messages.at(-1)?.content).toBe("latest");
  });

  it("does not trim Phase 2 messages when total tokens exactly matches the budget", () => {
    const messages = [user("keep"), assistant("fit")];
    const exactBudget = estimateConversationTokens(messages, { estimator: lengthEstimator });
    const result = trimConversationMessages(messages, {
      estimator: lengthEstimator,
      maxContextWindowTokens: exactBudget,
      outputReserveTokens: 0
    });

    expect(result.messages).toEqual(messages);
    expect(result.estimatedTokens).toBe(exactBudget);
  });

  it("triggers proactive compaction at the working budget while still under the hard cap", () => {
    // Five user/assistant pairs — each pair ~7 tokens with the lengthEstimator
    // (string length + DEFAULT_MESSAGE_STRUCTURE_OVERHEAD=20 → counted by
    // estimateConversationTokens internally). Set the hard cap WAY above
    // total so the legacy trigger doesn't fire; set workingBudgetTokens
    // below the total so the proactive trigger DOES fire.
    const messages = [
      user("first question"),
      assistant("first answer"),
      user("second question"),
      assistant("second answer"),
      user("third question"),
      assistant("third answer"),
      user("latest question")
    ];
    const total = estimateConversationTokens(messages, { estimator: lengthEstimator });
    const hardCap = total * 4;
    const workingBudget = Math.floor(total / 2);

    const result = trimConversationMessages(messages, {
      estimator: lengthEstimator,
      insertSummary: false,
      maxContextWindowTokens: hardCap,
      outputReserveTokens: 0,
      workingBudgetTokens: workingBudget
    });

    expect(result.triggeredBy).toBe("working_budget");
    expect(result.removedCount).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeLessThanOrEqual(workingBudget);
    // The latest user message must still be there.
    expect(result.messages.at(-1)?.content).toBe("latest question");
  });

  it("falls through to none when neither budget is exceeded", () => {
    const messages = [user("alpha"), assistant("beta")];
    const total = estimateConversationTokens(messages, { estimator: lengthEstimator });
    const result = trimConversationMessages(messages, {
      estimator: lengthEstimator,
      maxContextWindowTokens: total * 10,
      outputReserveTokens: 0,
      workingBudgetTokens: total * 5
    });

    expect(result.triggeredBy).toBe("none");
    expect(result.removedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("hard limit takes precedence over working budget when both are exceeded", () => {
    const messages = [
      user("a"),
      assistant("b"),
      user("c"),
      assistant("d"),
      user("e")
    ];
    const result = trimConversationMessages(messages, {
      estimator: lengthEstimator,
      insertSummary: false,
      maxContextWindowTokens: 25, // tight hard cap so structural overhead alone forces it
      outputReserveTokens: 0,
      workingBudgetTokens: 10 // even tighter — but hard_limit wins reporting
    });

    expect(result.triggeredBy).toBe("hard_limit");
    expect(result.removedCount).toBeGreaterThan(0);
  });

  it("clamps a working budget that exceeds the hard cap (silently falls back)", () => {
    const messages = [user("alpha"), assistant("beta"), user("gamma")];
    const total = estimateConversationTokens(messages, { estimator: lengthEstimator });
    const hardCap = Math.floor(total / 2);
    const result = trimConversationMessages(messages, {
      estimator: lengthEstimator,
      insertSummary: false,
      maxContextWindowTokens: hardCap,
      outputReserveTokens: 0,
      // Caller mistakenly passes a working budget > hard budget. The
      // implementation must NOT use it as a no-op upper bound — the
      // hard cap still triggers normally.
      workingBudgetTokens: total * 100
    });

    expect(result.triggeredBy).toBe("hard_limit");
    expect(result.removedCount).toBeGreaterThan(0);
  });

  it("inserts a neutral compaction summary after enough messages are removed", () => {
    const result = trimConversationMessages(
      [
        user("first topic"),
        assistant("first answer"),
        user("second topic"),
        assistant("second answer"),
        user("third topic"),
        assistant("third answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 120,
        outputReserveTokens: 20
      }
    );

    expect(result.summaryInserted).toBe(true);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
  });

  it("preserves pinned entities from dropped user messages in the compaction summary", () => {
    const result = trimConversationMessages(
      [
        user("Investigate REACTOR-100 and the \"billing drift\" report"),
        assistant("old answer"),
        user("Then compare BB30-2581"),
        assistant("second answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 110,
        outputReserveTokens: 20
      }
    );

    expect(result.summaryInserted).toBe(true);
    expect(result.messages[0]?.content).toContain(COMPACTION_PINNED_ENTITIES_PREFIX);
    expect(result.messages[0]?.content).toContain("REACTOR-100");
    expect(result.messages[0]?.content).toContain("billing drift");
    expect(result.messages[0]?.content).toContain("BB30-2581");
  });

  it("merges the previous compaction summary on later trim rounds", () => {
    const first = trimConversationMessages(
      [
        user("first topic REACTOR-101"),
        assistant("first answer"),
        user("second topic"),
        assistant("second answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 100,
        outputReserveTokens: 20
      }
    );
    const second = trimConversationMessages(
      [
        ...first.messages,
        user("new topic"),
        assistant("new answer"),
        user("latest")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 95,
        outputReserveTokens: 20
      }
    );

    expect(second.summaryInserted).toBe(true);
    expect(second.messages[0]?.content).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(second.messages[0]?.content).toContain("Additional compaction round");
    expect(second.messages[0]?.content).toContain("REACTOR-101");
  });

  it("includes the personaSnapshot in the compaction summary when a trim fires", () => {
    const result = trimConversationMessages(
      [
        user("first topic"),
        assistant("first answer"),
        user("second topic"),
        assistant("second answer"),
        user("third topic"),
        assistant("third answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 120,
        outputReserveTokens: 20,
        personaSnapshot: "name=Alice; tz=Asia/Seoul; preferred_lang=ko"
      }
    );

    expect(result.summaryInserted).toBe(true);
    expect(result.messages[0]?.content).toContain(`${COMPACTION_PERSONA_SNAPSHOT_PREFIX}: `);
    expect(result.messages[0]?.content).toContain("name=Alice");
    expect(result.messages[0]?.content).toContain("tz=Asia/Seoul");
  });

  it("does NOT add a persona-snapshot block when no compaction fires", () => {
    // Under-budget conversation → no summary, no User context line.
    // Critical: the feature must not bloat prompts on cheap/short runs.
    const result = trimConversationMessages(
      [user("hi"), assistant("hello")],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 1_000,
        outputReserveTokens: 0,
        personaSnapshot: "name=Alice"
      }
    );

    expect(result.summaryInserted).toBe(false);
    expect(result.messages[0]?.content).not.toContain(COMPACTION_PERSONA_SNAPSHOT_PREFIX);
  });

  it("treats an empty/whitespace personaSnapshot as absent (no User context line)", () => {
    const result = trimConversationMessages(
      [
        user("first topic"),
        assistant("first answer"),
        user("second topic"),
        assistant("second answer"),
        user("third topic"),
        assistant("third answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 120,
        outputReserveTokens: 20,
        personaSnapshot: "   "
      }
    );

    expect(result.summaryInserted).toBe(true);
    expect(result.messages[0]?.content).not.toContain(COMPACTION_PERSONA_SNAPSHOT_PREFIX);
  });

  it("trimToolOutput passes through when input fits the cap", () => {
    const result = trimToolOutput("hello world", { maxChars: 100 });
    expect(result.truncated).toBe(false);
    expect(result.output).toBe("hello world");
    expect(result.originalLength).toBe(11);
  });

  it("trimToolOutput preserves head + tail with an elision marker", () => {
    const long = "A".repeat(50) + "MIDDLE-CONTENT" + "B".repeat(50);
    const result = trimToolOutput(long, { maxChars: 60 });
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(long.length);
    expect(result.output.length).toBeLessThanOrEqual(60);
    expect(result.output).toContain("[truncated:");
    expect(result.output).toContain("chars elided");
    // Head should still start with 'A's; tail should end with 'B's.
    expect(result.output.startsWith("A")).toBe(true);
    expect(result.output.endsWith("B")).toBe(true);
    // Middle content must be elided.
    expect(result.output).not.toContain("MIDDLE-CONTENT");
  });

  it("trimToolOutput surfaces the optional hint inside the marker", () => {
    const long = "x".repeat(500);
    const result = trimToolOutput(long, {
      hint: "tool muse.fs.read returned a larger result",
      maxChars: 100
    });
    expect(result.output).toContain("muse.fs.read");
  });

  it("trimToolOutput honors headRatio for asymmetric head/tail allocation", () => {
    const long = "X".repeat(40) + "Y".repeat(40);
    const result = trimToolOutput(long, { headRatio: 0.9, maxChars: 50 });
    // Most of the budget went to head → mostly X's.
    const xCount = (result.output.match(/X/gu) ?? []).length;
    const yCount = (result.output.match(/Y/gu) ?? []).length;
    expect(xCount).toBeGreaterThan(yCount);
  });

  it("trimToolOutput is a no-op when maxChars <= 0", () => {
    const long = "z".repeat(1_000);
    expect(trimToolOutput(long, { maxChars: 0 })).toMatchObject({
      output: long,
      truncated: false
    });
    expect(trimToolOutput(long, { maxChars: -1 })).toMatchObject({
      output: long,
      truncated: false
    });
  });

  it("trimToolOutput collapses to marker only when budget is below marker length", () => {
    const long = "q".repeat(1_000);
    const result = trimToolOutput(long, { maxChars: 10 });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(10);
  });

  it("strips a stale persona snapshot from the carried previousSummary on the next compaction round", () => {
    // First compaction stamps personaSnapshot="ver=1".
    const first = trimConversationMessages(
      [
        user("first topic REACTOR-101"),
        assistant("first answer"),
        user("second topic"),
        assistant("second answer"),
        user("current topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 100,
        outputReserveTokens: 20,
        personaSnapshot: "ver=1"
      }
    );
    expect(first.messages[0]?.content).toContain("ver=1");

    // Second compaction with a NEW snapshot — the stale `ver=1` line
    // must be stripped, only `ver=2` should appear.
    const second = trimConversationMessages(
      [
        ...first.messages,
        assistant("answer to current topic"),
        user("yet another"),
        assistant("yet another answer"),
        user("latest topic")
      ],
      {
        estimator: lengthEstimator,
        maxContextWindowTokens: 100,
        outputReserveTokens: 20,
        personaSnapshot: "ver=2"
      }
    );

    expect(second.summaryInserted).toBe(true);
    expect(second.messages[0]?.content).toContain("ver=2");
    expect(second.messages[0]?.content).not.toContain("ver=1");
  });
});

describe("task memory store", () => {
  it("rejects structurally invalid task memory while reporting quality warnings", () => {
    const store = new InMemoryTaskMemoryStore();
    const report = evaluateTaskMemoryQuality({
      blockers: [],
      goal: "Investigate migration parity",
      sessionId: "session-1",
      status: "blocked",
      taskId: "task-1"
    });

    expect(report).toMatchObject({
      ok: true,
      summary: { errorCount: 0, warningCount: 1 }
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "blocked_without_blocker",
      severity: "warning"
    }));
    expect(() =>
      store.save({
        goal: "   ",
        sessionId: "session-1",
        taskId: "task-invalid"
      })
    ).toThrow(TaskMemoryQualityError);
  });

  it("finds active task memory by session and user fallback rules", async () => {
    const store = new InMemoryTaskMemoryStore();

    await store.save({
      goal: "Keep migration context",
      sessionId: "session-1",
      taskId: "task-session"
    });
    await store.save({
      goal: "User-specific context",
      sessionId: "session-1",
      taskId: "task-user",
      userId: "user-1"
    });

    expect(await store.findActiveBySession("session-1", "user-1")).toMatchObject({
      taskId: "task-user"
    });
    expect(await store.findActiveBySession("session-1")).toMatchObject({
      taskId: "task-session"
    });
  });

  it("purges terminal task memory older than the cutoff", async () => {
    const store = new InMemoryTaskMemoryStore({ retentionMs: 365 * 24 * 60 * 60 * 1000 });
    const old = new Date("2026-01-01T00:00:00.000Z");
    const fresh = new Date("2026-04-01T00:00:00.000Z");

    await store.save({
      goal: "Old completed task",
      sessionId: "session-1",
      status: "completed",
      taskId: "old-task",
      updatedAt: old
    });
    await store.save({
      goal: "Fresh completed task",
      sessionId: "session-1",
      status: "completed",
      taskId: "fresh-task",
      updatedAt: fresh
    });

    expect(await store.purgeTerminalOlderThan(new Date("2026-02-01T00:00:00.000Z"))).toBe(1);
    expect(await store.findById("old-task")).toBeUndefined();
    expect(await store.findById("fresh-task")).toMatchObject({ taskId: "fresh-task" });
  });

  it("purges expired task memory by retention window", async () => {
    const store = new InMemoryTaskMemoryStore({ retentionMs: 1000 });

    await store.save({
      goal: "Expired task",
      sessionId: "session-1",
      taskId: "expired-task",
      updatedAt: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(await store.purgeExpired(new Date("2026-01-01T00:00:01.001Z"))).toBe(1);
    expect(await store.findById("expired-task")).toBeUndefined();
  });

  it("builds PostgreSQL upsert SQL for Kysely task memory", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = buildTaskMemoryUpsertQuery(
      db,
      {
        decisions: [{ decidedAt: now, summary: "Use Kysely" }],
        goal: "Persist task memory",
        metadata: { source: "test" },
        plan: [{ status: "in_progress", step: "write store" }],
        sessionId: "session-1",
        taskId: "task-1",
        updatedAt: now,
        userId: "user-1"
      },
      { now: () => now, retentionMs: 1_000 }
    ).compile();

    expect(query.sql).toContain('insert into "task_memories"');
    expect(query.sql).toContain('on conflict ("task_id") do update');
    expect(query.sql).toContain("returning *");
    expect(query.parameters).toContain("task-1");
    expect(query.parameters).toContain("session-1");
  });

  it("builds active task memory lookup SQL and maps rows", () => {
    const db = createPostgresBuilder();
    const compiled = buildActiveTaskMemoryQuery(db, "session-1", "user-1").compile();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const insert = createTaskMemoryInsert(
      {
        blockers: [{ description: "blocked" }],
        goal: "Persist task memory",
        sessionId: "session-1",
        status: "blocked",
        taskId: "task-1",
        updatedAt: now,
        userId: "user-1"
      },
      { now: () => now, retentionMs: 1_000 }
    );

    expect(compiled.sql).toContain('from "task_memories"');
    expect(compiled.sql).toContain('"session_id" = $1');
    expect(compiled.sql).toContain('"user_id" = $4');
    expect(compiled.parameters).toEqual(["session-1", "active", "blocked", "user-1", 1]);
    expect(mapTaskMemoryRow(insert)).toMatchObject({
      blockers: [{ description: "blocked" }],
      goal: "Persist task memory",
      sessionId: "session-1",
      status: "blocked",
      taskId: "task-1",
      userId: "user-1"
    });
  });
});

describe("user memory store", () => {
  it("updates facts and preferences in memory", async () => {
    const store = new InMemoryUserMemoryStore();

    await store.upsertFact("user-1", "team", "platform");
    const memory = await store.upsertPreference("user-1", "tone", "direct");

    expect(memory).toMatchObject({
      facts: { team: "platform" },
      preferences: { tone: "direct" },
      userId: "user-1"
    });
    expect(await store.deleteByUserId("user-1")).toBe(true);
    expect(await store.findByUserId("user-1")).toBeUndefined();
  });

  it("builds user memory rows and maps persisted values", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-05-06T00:00:00.000Z");
    const row = createUserMemoryInsert({
      facts: { team: "platform" },
      preferences: { tone: "direct" },
      recentTopics: ["migration"],
      updatedAt: now,
      userId: "user-1"
    });
    const compiled = db
      .insertInto("user_memories")
      .values(row)
      .onConflict((oc) => oc.column("user_id").doUpdateSet({ facts: row.facts }))
      .returningAll()
      .compile();

    expect(compiled.sql).toContain('insert into "user_memories"');
    expect(compiled.sql).toContain('on conflict ("user_id") do update');
    expect(mapUserMemoryRow(row)).toMatchObject({
      facts: { team: "platform" },
      preferences: { tone: "direct" },
      recentTopics: ["migration"],
      userId: "user-1"
    });
  });
});

describe("conversation summary store", () => {
  it("upserts, reads, and deletes conversation summaries in memory", async () => {
    const store = new InMemoryConversationSummaryStore({
      now: () => new Date("2026-05-06T00:00:00.000Z")
    });

    await store.save({
      facts: [{
        category: "DECISION",
        extractedAt: new Date("2026-05-05T00:00:00.000Z"),
        key: "runtime",
        value: "provider-neutral"
      }],
      narrative: "Keep the shared agent runtime provider-neutral.",
      sessionId: "session-1",
      summarizedUpToIndex: 12
    });
    await store.save({
      narrative: "Preserve message pair integrity during trimming.",
      sessionId: "session-1",
      summarizedUpToIndex: 18
    });

    expect(await store.get("session-1")).toMatchObject({
      narrative: "Preserve message pair integrity during trimming.",
      sessionId: "session-1",
      summarizedUpToIndex: 18
    });
    expect(await store.delete("session-1")).toBe(true);
    expect(await store.get("session-1")).toBeUndefined();
  });

  it("builds PostgreSQL upsert SQL and maps persisted conversation summaries", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-05-06T00:00:00.000Z");
    const summary = {
      facts: [{
        category: "ENTITY" as const,
        extractedAt: now,
        key: "project",
        value: "Muse"
      }],
      narrative: "Migration work is continuing.",
      sessionId: "session-1",
      summarizedUpToIndex: 7
    };
    const row = createConversationSummaryInsert(summary, { now: () => now });
    const compiled = buildConversationSummaryUpsertQuery(db, summary, { now: () => now }).compile();

    expect(compiled.sql).toContain('insert into "conversation_summaries"');
    expect(compiled.sql).toContain('on conflict ("session_id") do update');
    expect(compiled.sql).toContain("returning *");
    expect(row).toMatchObject({
      narrative: "Migration work is continuing.",
      session_id: "session-1",
      summarized_up_to: 7
    });
    expect(mapConversationSummaryRow(row)).toMatchObject({
      facts: [{ category: "ENTITY", key: "project", value: "Muse" }],
      narrative: "Migration work is continuing.",
      sessionId: "session-1",
      summarizedUpToIndex: 7
    });
  });
});

function system(content: string): ConversationMessage {
  return { content, role: "system" };
}

function user(content: string): ConversationMessage {
  return { content, role: "user" };
}

function assistant(content: string): ConversationMessage {
  return { content, role: "assistant" };
}

function assistantTool(name: string, args: Record<string, string>): ConversationMessage {
  return {
    content: "",
    role: "assistant",
    toolCalls: [{ arguments: args, id: `call-${name}`, name }]
  };
}

function tool(content: string): ConversationMessage {
  return { content, role: "tool", toolCallId: "call-search" };
}

function assistantMultiTool(names: readonly string[]): ConversationMessage {
  return {
    content: "",
    role: "assistant",
    toolCalls: names.map((name) => ({ arguments: {}, id: `call-${name}`, name }))
  };
}

function toolFor(toolCallId: string, content: string): ConversationMessage {
  return { content, role: "tool", toolCallId };
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

describe("createUserMemoryAutoExtractHook", () => {
  function makeContext(userId: string | undefined, userText: string) {
    return {
      input: {
        messages: [{ content: userText, role: "user" as const }],
        ...(userId ? { metadata: { userId } } : {})
      },
      runId: "run-1"
    };
  }

  function makeProvider(payload: string) {
    return {
      id: "stub",
      generate: vi.fn(async () => ({ id: "r-1", model: "stub", output: payload })),
      listModels: vi.fn(async () => []),
      stream: vi.fn(async function* () {})
    };
  }

  function makeResponse(text: string) {
    return { id: "r-stub", model: "stub", output: text };
  }

  it("persists facts and preferences from a successful extraction", async () => {
    const store = new InMemoryUserMemoryStore();
    const provider = makeProvider(JSON.stringify({
      facts: { spouse_name: "Alex" },
      preferences: { favorite_drink: "matcha latte" }
    }));
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: provider as never, store });

    await hook.afterComplete!(
      makeContext("user-42", "By the way, my wife Alex prefers matcha lattes."),
      makeResponse("Got it.")
    );

    const memory = await store.findByUserId("user-42");
    expect(memory?.facts).toMatchObject({ spouse_name: "Alex" });
    expect(memory?.preferences).toMatchObject({ favorite_drink: "matcha latte" });
    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("skips when no userId is present", async () => {
    const store = new InMemoryUserMemoryStore();
    const provider = makeProvider("{}");
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: provider as never, store });

    await hook.afterComplete!(makeContext(undefined, "anything"), makeResponse("ok"));
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("treats malformed JSON output as fail-open (no throw, no write)", async () => {
    const store = new InMemoryUserMemoryStore();
    const provider = makeProvider("```not json```");
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: provider as never, store });

    await hook.afterComplete!(makeContext("user-1", "hi"), makeResponse("hi back"));
    expect(await store.findByUserId("user-1")).toBeUndefined();
  });

  it("clamps key length and snake_cases noisy keys", async () => {
    const store = new InMemoryUserMemoryStore();
    const provider = makeProvider(JSON.stringify({
      facts: { "Loud  Noisy Key!! WithLotsOfText": "value-A" },
      preferences: {}
    }));
    const hook = createUserMemoryAutoExtractHook({
      maxKeyLength: 16,
      model: "stub",
      modelProvider: provider as never,
      store
    });

    await hook.afterComplete!(makeContext("user-9", "x"), makeResponse("y"));
    const memory = await store.findByUserId("user-9");
    const keys = Object.keys(memory?.facts ?? {});
    expect(keys.length).toBe(1);
    expect(keys[0]?.length).toBeLessThanOrEqual(16);
    expect(keys[0]).toMatch(/^[a-z0-9_]+$/);
  });
});
