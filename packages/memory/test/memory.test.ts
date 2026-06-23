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
  composeUserModelSnapshot,
  EMPTY_USER_MODEL,
  InMemoryContextReferenceStore,
  trimToolOutput,
  buildActiveTaskMemoryQuery,
  buildConversationSummaryUpsertQuery,
  buildTaskMemoryUpsertQuery,
  computeApproximateTokens,
  createConversationSummaryInsert,
  createUserMemoryAutoExtractHook,
  pickAutoExtractSystemPrompt,
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

  it("weights CJK/Korean materially heavier than Latin (protects the budget/compaction trigger)", () => {
    // Korean is the primary user language; a regression to a
    // naive English `chars/4` would silently under-count Korean
    // ~2.7x and defeat the small-context-Qwen compaction trigger.
    // The tiny "안녕"→1 case above can't catch that (Math.max(1)
    // floors both), so lock the relative weighting here.
    const latin90 = computeApproximateTokens("a".repeat(90));
    const korean90 = computeApproximateTokens("가".repeat(90));
    expect(latin90).toBe(22);   // floor(90 / 4)
    expect(korean90).toBe(60);  // floor((90*2 + 1) / 3)
    expect(korean90).toBeGreaterThan(latin90);
    expect(korean90).toBeGreaterThan(Math.floor(90 / 4)); // > the naive English heuristic
    // Mixed script: both classes contribute, CJK dominates.
    expect(computeApproximateTokens("hello 안녕하세요")).toBe(4);
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

  it("counts each parallel tool call's wire envelope (multi-tool turn is not undercounted)", () => {
    // Two assistant turns, identical content, differing only in how many
    // tool calls they carry. The 3-call turn must cost meaningfully more
    // than the 1-call turn — at least ~2 extra envelopes — even though the
    // tool args are tiny. Pre-fix both collapsed to one message overhead.
    const one = estimateConversationTokens([assistantMultiTool(["a"])], { estimator: lengthEstimator });
    const three = estimateConversationTokens([assistantMultiTool(["a", "b", "c"])], {
      estimator: lengthEstimator
    });
    // 2 extra calls: each adds its name (1 char) + "{}" args (2) + envelope (8) = 11.
    expect(three - one).toBe(22);
  });

  it("charges a tool-result message its own wire envelope", () => {
    const withTool = estimateConversationTokens([toolFor("call-x", "ok")], { estimator: lengthEstimator });
    const asUser = estimateConversationTokens([user("ok")], { estimator: lengthEstimator });
    // identical content ("ok") + same base overhead; the tool envelope is the gap.
    expect(withTool - asUser).toBe(8);
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
        // Budget = exact size of the kept user+assistant+tool trio.
        // Includes per-tool-call (+8) and tool-result (+8) wire-envelope
        // overhead, so the leading system memories are what gets dropped.
        estimator: lengthEstimator,
        maxContextWindowTokens: 113,
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

  it("trimToolOutput reports the EXACT elided char count, not original-minus-cap", () => {
    // Single repeated char so every retained char is countable: the
    // marker's "<N> chars elided of <M> total" must be arithmetically
    // exact (pre-fix it under-reported by the marker's own length,
    // since it used originalLength - maxChars).
    const long = "H".repeat(1_000);
    for (const opts of [{ maxChars: 120 }, { hint: "re-fetch with offset", maxChars: 140 }]) {
      const result = trimToolOutput(long, opts);
      const match = result.output.match(/\[truncated: (\d+) chars elided of (\d+) total/u);
      expect(match).not.toBeNull();
      const reportedElided = Number(match![1]);
      const reportedTotal = Number(match![2]);
      const retained = (result.output.match(/H/gu) ?? []).length;
      expect(reportedTotal).toBe(1_000);
      expect(reportedElided).toBe(1_000 - retained);
      expect(result.output.length).toBeLessThanOrEqual(opts.maxChars);
      expect(result.originalLength).toBe(1_000);
    }
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

describe("composeUserModelSnapshot", () => {
  const now = new Date("2026-05-10T00:00:00.000Z");

  it("returns undefined for an empty model so callers can short-circuit", () => {
    expect(composeUserModelSnapshot(EMPTY_USER_MODEL)).toBeUndefined();
  });

  it("renders preferences with optional category prefix", () => {
    const snapshot = composeUserModelSnapshot({
      ...EMPTY_USER_MODEL,
      preferences: [
        { category: "style", id: "concise", kind: "preference", updatedAt: now, value: "yes" },
        { id: "no-emoji", kind: "preference", updatedAt: now, value: "true" }
      ]
    });
    expect(snapshot).toContain("pref.style.concise=yes");
    // No category → bare `pref.<id>=`.
    expect(snapshot).toContain("pref.no-emoji=true");
  });

  it("renders schedule slots with optional recurrence in parens", () => {
    const snapshot = composeUserModelSnapshot({
      ...EMPTY_USER_MODEL,
      schedule: [
        { id: "wakeup", kind: "schedule", recurrence: "daily 07:00 KST", updatedAt: now, value: "morning routine" }
      ]
    });
    expect(snapshot).toContain("sched.wakeup=morning routine (daily 07:00 KST)");
  });

  it("renders veto slots with optional scope tag", () => {
    const snapshot = composeUserModelSnapshot({
      ...EMPTY_USER_MODEL,
      vetoes: [
        { id: "no-eggs", kind: "veto", scope: "food", updatedAt: now, value: "do not suggest eggs" },
        { id: "no-meetings-mondays", kind: "veto", updatedAt: now, value: "block all" }
      ]
    });
    expect(snapshot).toContain("veto.food.no-eggs=do not suggest eggs");
    // No scope → bare `veto.<id>=`.
    expect(snapshot).toContain("veto.no-meetings-mondays=block all");
  });

  it("renders goals with progress and dueAt decorators", () => {
    const snapshot = composeUserModelSnapshot({
      ...EMPTY_USER_MODEL,
      goals: [
        {
          dueAt: new Date("2026-03-31T00:00:00.000Z"),
          id: "muse-v1",
          kind: "goal",
          progress: 0.5,
          updatedAt: now,
          value: "ship Muse 1.0"
        }
      ]
    });
    expect(snapshot).toContain("goal.muse-v1=ship Muse 1.0 (50%, due 2026-03-31)");
  });

  it("clamps progress to [0,1] before formatting", () => {
    const overrun = composeUserModelSnapshot({
      ...EMPTY_USER_MODEL,
      goals: [
        { id: "g1", kind: "goal", progress: 1.5, updatedAt: now, value: "x" }
      ]
    });
    expect(overrun).toContain("(100%)");
    const negative = composeUserModelSnapshot({
      ...EMPTY_USER_MODEL,
      goals: [
        { id: "g2", kind: "goal", progress: -0.3, updatedAt: now, value: "x" }
      ]
    });
    expect(negative).toContain("(0%)");
  });

  it("caps each kind at maxPerKind and reports the elided count", () => {
    const snapshot = composeUserModelSnapshot(
      {
        ...EMPTY_USER_MODEL,
        preferences: Array.from({ length: 8 }, (_unused, index) => ({
          id: `p${index}`,
          kind: "preference" as const,
          updatedAt: now,
          value: `v${index}`
        }))
      },
      { maxPerKind: 3 }
    );
    expect(snapshot).toContain("pref.p0=v0");
    expect(snapshot).toContain("pref.p2=v2");
    expect(snapshot).not.toContain("pref.p3=v3");
    expect(snapshot).toContain("[5 slots elided]");
  });

  it("keeps a hard veto when chatty preferences overflow maxChars (safety constraints lead)", () => {
    const snapshot = composeUserModelSnapshot(
      {
        ...EMPTY_USER_MODEL,
        preferences: Array.from({ length: 8 }, (_unused, index) => ({
          id: `p${index}`,
          kind: "preference" as const,
          updatedAt: now,
          value: "x".repeat(60)
        })),
        vetoes: [
          { id: "no-eggs", kind: "veto", scope: "food", updatedAt: now, value: "do not suggest eggs" }
        ]
      },
      { maxChars: 120, maxPerKind: 100 }
    );
    expect(snapshot?.length ?? 0).toBeLessThanOrEqual(120);
    // The safety veto survives; soft preferences are what gets elided.
    expect(snapshot).toContain("veto.food.no-eggs=do not suggest eggs");
    expect(snapshot).toContain("slots elided");
  });

  it("right-truncates with elided-count tail when composed snapshot exceeds maxChars", () => {
    const snapshot = composeUserModelSnapshot(
      {
        ...EMPTY_USER_MODEL,
        preferences: Array.from({ length: 8 }, (_unused, index) => ({
          id: `p${index}`,
          kind: "preference" as const,
          updatedAt: now,
          value: "x".repeat(40)
        }))
      },
      { maxChars: 100, maxPerKind: 100 }
    );
    expect(snapshot?.length ?? 0).toBeLessThanOrEqual(100);
    expect(snapshot).toContain("slots elided");
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

  it("round-trips typed UserModel slots through the Kysely insert builder + row mapper", () => {
    const now = new Date("2026-05-10T00:00:00.000Z");
    const insert = createUserMemoryInsert({
      facts: { team: "platform" },
      preferences: { tone: "concise" },
      recentTopics: [],
      updatedAt: now,
      userId: "user-2",
      userModel: {
        goals: [
          {
            dueAt: new Date("2026-08-01T00:00:00.000Z"),
            id: "muse-v1",
            kind: "goal",
            progress: 0.4,
            updatedAt: now,
            value: "ship Muse 1.0"
          }
        ],
        preferences: [
          { category: "style", id: "concise", kind: "preference", updatedAt: now, value: "yes" }
        ],
        schedule: [],
        vetoes: [
          { id: "no-eggs", kind: "veto", scope: "food", updatedAt: now, value: "do not suggest eggs" }
        ]
      }
    });
    // user_model column populated as a JSONB-ready object.
    expect(insert.user_model).toBeTruthy();

    // Map it back through mapUserMemoryRow — Dates should rehydrate
    // and the discriminated union should reconstruct each slot.
    const mapped = mapUserMemoryRow(insert);
    expect(mapped.userModel).toBeDefined();
    expect(mapped.userModel?.preferences).toHaveLength(1);
    expect(mapped.userModel?.vetoes).toHaveLength(1);
    expect(mapped.userModel?.goals).toHaveLength(1);
    expect(mapped.userModel?.goals[0]?.dueAt).toBeInstanceOf(Date);
    expect(mapped.userModel?.goals[0]?.progress).toBe(0.4);
    // Round-trip through actual JSON (simulates a Postgres JSONB
    // read where the value comes back already parsed but Dates as
    // ISO strings).
    const jsonRoundTripped = JSON.parse(JSON.stringify(insert));
    const rehydrated = mapUserMemoryRow(jsonRoundTripped);
    expect(rehydrated.userModel?.goals[0]?.dueAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(rehydrated.userModel?.goals[0]?.value).toBe("ship Muse 1.0");
  });

  it("treats a null user_model column as an absent userModel (legacy rows)", () => {
    const insert = createUserMemoryInsert({
      facts: {},
      preferences: {},
      recentTopics: [],
      updatedAt: new Date(),
      userId: "old-user"
    });
    // No userModel on input → user_model column is null on insert.
    expect(insert.user_model).toBeNull();
    const mapped = mapUserMemoryRow(insert);
    expect(mapped.userModel).toBeUndefined();
  });

  it("upserts typed UserModel slots into the in-memory store with replace-by-id semantics", () => {
    const store = new InMemoryUserMemoryStore();
    const now = new Date("2026-05-10T00:00:00Z");

    const after1 = store.upsertUserModelSlot!("u1", {
      category: "style",
      id: "concise",
      kind: "preference",
      updatedAt: now,
      value: "yes"
    });
    expect(after1.userModel?.preferences).toHaveLength(1);
    expect(after1.userModel?.preferences[0]).toMatchObject({ id: "concise", value: "yes" });

    const after2 = store.upsertUserModelSlot!("u1", {
      id: "no-eggs",
      kind: "veto",
      scope: "food",
      updatedAt: now,
      value: "do not suggest eggs"
    });
    expect(after2.userModel?.preferences).toHaveLength(1);
    expect(after2.userModel?.vetoes).toHaveLength(1);

    // Same id within the same kind → REPLACE, not append.
    const after3 = store.upsertUserModelSlot!("u1", {
      category: "style",
      id: "concise",
      kind: "preference",
      updatedAt: now,
      value: "always"
    });
    expect(after3.userModel?.preferences).toHaveLength(1);
    expect(after3.userModel?.preferences[0]?.value).toBe("always");
    // Other kinds untouched.
    expect(after3.userModel?.vetoes).toHaveLength(1);
  });

  it("preserves typed slots through findByUserId clone and through fact upserts", () => {
    const store = new InMemoryUserMemoryStore();
    const now = new Date("2026-05-10T00:00:00Z");
    store.upsertUserModelSlot!("u1", {
      id: "muse-v1",
      kind: "goal",
      progress: 0.3,
      updatedAt: now,
      value: "ship 1.0"
    });
    store.upsertFact("u1", "name", "Alice");

    const memory = store.findByUserId("u1");
    expect(memory?.facts.name).toBe("Alice");
    expect(memory?.userModel?.goals).toHaveLength(1);
    expect(memory?.userModel?.goals[0]?.id).toBe("muse-v1");

    // Mutating the returned arrays must not affect the stored copy
    // (cloneUserMemory should deep-copy the slot arrays).
    (memory?.userModel?.goals as unknown as { length: number }).length = 0;
    const memoryAgain = store.findByUserId("u1");
    expect(memoryAgain?.userModel?.goals).toHaveLength(1);
  });

  it("legacy callers without typed slots see no userModel field at all", () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact("u2", "team", "platform");
    const memory = store.findByUserId("u2");
    expect(memory?.userModel).toBeUndefined();
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

  it("persists typed veto and goal slots from the extraction", async () => {
    const store = new InMemoryUserMemoryStore();
    const provider = makeProvider(JSON.stringify({
      facts: {},
      goals: [
        { id: "ship_v1", value: "ship Muse 1.0 by Q1" }
      ],
      preferences: {},
      vetoes: [
        { id: "no_eggs", scope: "food", value: "never suggest eggs" },
        { id: "no_meetings_mondays", value: "block all meetings on Mondays" }
      ]
    }));
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: provider as never, store });

    await hook.afterComplete!(
      makeContext("user-7", "Never suggest eggs and block all meetings on Mondays. Also I want to ship Muse 1.0 by Q1."),
      makeResponse("Noted.")
    );

    const memory = await store.findByUserId("user-7");
    expect(memory?.userModel?.vetoes).toHaveLength(2);
    const eggVeto = memory?.userModel?.vetoes.find((slot) => slot.id === "no_eggs");
    expect(eggVeto?.value).toBe("never suggest eggs");
    expect(eggVeto?.scope).toBe("food");
    const mondayVeto = memory?.userModel?.vetoes.find((slot) => slot.id === "no_meetings_mondays");
    expect(mondayVeto?.scope).toBeUndefined();
    expect(memory?.userModel?.goals).toHaveLength(1);
    expect(memory?.userModel?.goals[0]).toMatchObject({
      id: "ship_v1",
      kind: "goal",
      value: "ship Muse 1.0 by Q1"
    });
  });

  it("ignores malformed slot entries and respects per-kind caps", async () => {
    const store = new InMemoryUserMemoryStore();
    const provider = makeProvider(JSON.stringify({
      facts: {},
      goals: [
        { id: "g1", value: "first goal" },
        { id: "g2", value: "second goal" },
        { id: "g3", value: "third goal" }, // exceeds maxGoalsPerExchange=2
        { id: "", value: "drops because empty id" },
        "not an object — drops",
        { id: "g4", value: "" }, // drops because empty value
        null
      ],
      preferences: {},
      vetoes: []
    }));
    const hook = createUserMemoryAutoExtractHook({
      maxGoalsPerExchange: 2,
      model: "stub",
      modelProvider: provider as never,
      store
    });

    await hook.afterComplete!(makeContext("user-8", "x"), makeResponse("y"));
    const memory = await store.findByUserId("user-8");
    expect(memory?.userModel?.goals).toHaveLength(2);
    expect(memory?.userModel?.goals.map((slot) => slot.id)).toEqual(["g1", "g2"]);
  });

  it("InMemoryContextReferenceStore stores, retrieves, lists, deletes, and TTL-evicts entries", () => {
    let now = new Date("2026-05-10T00:00:00.000Z");
    const store = new InMemoryContextReferenceStore({
      maxEntries: 3,
      now: () => now,
      ttlMs: 60_000
    });

    const entry = store.put({
      content: "first content",
      contentType: "text/plain",
      id: "ref-1",
      originalLength: 1_234,
      source: "muse.fs.read"
    });
    expect(entry).toMatchObject({
      content: "first content",
      contentType: "text/plain",
      id: "ref-1",
      originalLength: 1_234,
      source: "muse.fs.read"
    });
    expect(entry.createdAt.toISOString()).toBe("2026-05-10T00:00:00.000Z");

    expect(store.get("ref-1")?.content).toBe("first content");
    expect(store.get("missing")).toBeUndefined();
    expect(store.list()).toHaveLength(1);

    // Advance time past TTL → entry expires.
    now = new Date("2026-05-10T00:01:01.000Z"); // 61s later
    expect(store.get("ref-1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);

    // Cap eviction: put 4 with maxEntries=3 → oldest evicted.
    now = new Date("2026-05-10T00:02:00.000Z");
    store.put({ content: "a", id: "a" });
    now = new Date("2026-05-10T00:02:01.000Z");
    store.put({ content: "b", id: "b" });
    now = new Date("2026-05-10T00:02:02.000Z");
    store.put({ content: "c", id: "c" });
    now = new Date("2026-05-10T00:02:03.000Z");
    store.put({ content: "d", id: "d" });
    expect(store.get("a")).toBeUndefined(); // evicted
    expect(store.get("d")).toBeDefined();
    expect(store.list().map((entry) => entry.id)).toEqual(["b", "c", "d"]);

    expect(store.delete("c")).toBe(true);
    expect(store.delete("c")).toBe(false);
    expect(store.list()).toHaveLength(2);
  });

  it("InMemoryContextReferenceStore rejects empty ids and treats ttlMs=0 as never expiring", () => {
    const store = new InMemoryContextReferenceStore({ ttlMs: 0 });
    expect(() => store.put({ content: "x", id: "" })).toThrow("non-empty id");
    expect(() => store.put({ content: "x", id: "   " })).toThrow("non-empty id");

    store.put({ content: "permanent", id: "p1" });
    // Even after a long pretend wait, ttlMs=0 keeps the entry.
    expect(store.pruneExpired(new Date(Date.now() + 10 * 60 * 60 * 1_000))).toBe(0);
    expect(store.get("p1")?.content).toBe("permanent");
  });

  it("silently skips slot writes when the store doesn't implement upsertUserModelSlot", async () => {
    // Custom UserMemoryStore without the optional method — exercises
    // the guard so 3rd-party stores keep working.
    const captured: { fact?: string; preference?: string; slotCalls: number } = { slotCalls: 0 };
    const store = {
      async findByUserId() { return undefined; },
      async upsertFact(_uid: string, key: string, value: string) {
        captured.fact = `${key}=${value}`;
        return { facts: { [key]: value }, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "u" };
      },
      async upsertPreference(_uid: string, key: string, _value: string) {
        captured.preference = key;
        return { facts: {}, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "u" };
      },
      async deleteByUserId() { return false; }
      // No upsertUserModelSlot.
    } as InstanceType<typeof InMemoryUserMemoryStore>;

    const provider = makeProvider(JSON.stringify({
      facts: { x: "y" },
      goals: [{ id: "g1", value: "ship" }],
      preferences: {},
      vetoes: [{ id: "v1", value: "no" }]
    }));
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: provider as never, store });

    await hook.afterComplete!(makeContext("u", "x"), makeResponse("y"));
    expect(captured.fact).toBe("x=y");
    expect(captured.slotCalls).toBe(0); // never invoked because the store doesn't have the method
  });
});

describe("pickAutoExtractSystemPrompt", () => {
  it("uses the Korean prompt when the user message is mostly Hangul", () => {
    const prompt = pickAutoExtractSystemPrompt("저는 계란 알레르기가 있어요. 절대 계란 메뉴는 추천하지 마세요.");
    expect(prompt).toMatch(/규칙:/);
    expect(prompt).toMatch(/JSON 객체만 출력/);
  });

  it("uses the English prompt for English-only messages", () => {
    const prompt = pickAutoExtractSystemPrompt("By the way, my spouse Alex prefers matcha lattes in the morning.");
    expect(prompt).toMatch(/^You analyse a single exchange/);
    expect(prompt).toMatch(/Output only the JSON object/);
  });

  it("falls back to the English prompt when the message is mixed but mostly English", () => {
    const prompt = pickAutoExtractSystemPrompt("Sure, my Korean nickname is 진안 but the rest of my profile is in English.");
    expect(prompt).toMatch(/^You analyse a single exchange/);
  });

  it("uses the Korean prompt when Hangul ratio crosses the 30% threshold", () => {
    // 9 Hangul chars + 5 ASCII = ~64% Hangul.
    const prompt = pickAutoExtractSystemPrompt("저는 hello 오늘 좋아");
    expect(prompt).toMatch(/규칙:/);
  });

  it("falls back to English on empty input", () => {
    expect(pickAutoExtractSystemPrompt("")).toMatch(/^You analyse a single exchange/);
  });
});

describe("createUserMemoryAutoExtractHook prompt language", () => {
  it("sends the Korean system prompt when the user message is in Korean", async () => {
    const store = new InMemoryUserMemoryStore();
    const captured: { systemPrompt?: string } = {};
    const provider = {
      id: "stub",
      generate: vi.fn(async (request: { messages: Array<{ role: string; content: string }> }) => {
        const sys = request.messages.find((m) => m.role === "system");
        captured.systemPrompt = sys?.content;
        return { id: "r-ko", model: "stub", output: "{\"facts\":{},\"preferences\":{},\"vetoes\":[],\"goals\":[]}" };
      }),
      listModels: vi.fn(async () => []),
      stream: vi.fn(async function* () {})
    };
    const hook = createUserMemoryAutoExtractHook({ model: "stub", modelProvider: provider as never, store });

    await hook.afterComplete!(
      {
        input: {
          messages: [{ content: "저는 매일 아침 7시에 일어납니다.", role: "user" as const }],
          metadata: { userId: "u-ko" }
        },
        runId: "run-ko"
      },
      { id: "r", model: "stub", output: "알겠습니다." }
    );

    expect(captured.systemPrompt).toMatch(/규칙:/);
  });
});
