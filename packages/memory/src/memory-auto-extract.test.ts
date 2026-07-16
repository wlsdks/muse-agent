import type { ModelProvider, ModelResponse } from "@muse/model";
import { describe, expect, it } from "vitest";

import type { FactSupersession } from "./index.js";
import { createUserMemoryAutoExtractHook } from "./memory-auto-extract.js";
import { InMemoryUserMemoryStore } from "./memory-user-store.js";
import { formatLearnedConfirmation } from "./recently-learned.js";

function fakeProvider(extractionJson: string): ModelProvider {
  return {
    id: "fake",
    listModels: async () => [],
    generate: async () => ({ output: extractionJson }) as ModelResponse,
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("not used");
    }
  } as unknown as ModelProvider;
}

type AfterCompleteArgs = Parameters<NonNullable<ReturnType<typeof createUserMemoryAutoExtractHook>["afterComplete"]>>;

function turn(userId: string, userText: string): AfterCompleteArgs {
  return [
    { runId: "r", input: { messages: [{ role: "user", content: userText }], metadata: { userId } } } as AfterCompleteArgs[0],
    { output: "ok" } as ModelResponse
  ];
}

describe("createUserMemoryAutoExtractHook — option validation", () => {
  const createHook = (options: Record<string, number>) => createUserMemoryAutoExtractHook({
    store: new InMemoryUserMemoryStore(),
    modelProvider: fakeProvider("{}"),
    model: "m",
    ...options
  });

  it("rejects non-finite, fractional, and negative count limits before they can disable extraction bounds", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1]) {
      expect(() => createHook({ maxFactsPerExchange: value })).toThrow(RangeError);
      expect(() => createHook({ extractionCooldownMs: value })).toThrow(RangeError);
    }

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => createHook({ maxUserPromptChars: value })).toThrow(RangeError);
      expect(() => createHook({ extractionTimeoutMs: value })).toThrow(RangeError);
    }
  });

  it("retains zero as the explicit no-extraction and no-cooldown setting", () => {
    expect(() => createHook({ maxFactsPerExchange: 0, extractionCooldownMs: 0 })).not.toThrow();
  });

  it("clamps low character and timeout limits to their documented minimums", () => {
    expect(() => createHook({ maxUserPromptChars: 0, extractionTimeoutMs: -1 })).not.toThrow();
  });
});

describe("createUserMemoryAutoExtractHook — onLearned", () => {
  it("notifies the supersession recorded this turn when a fact CHANGES", async () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact("u", "home_city", "Seoul");
    const learned: FactSupersession[] = [];
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider('{"facts":{"home_city":"Busan"}}'),
      model: "m",
      extractionCooldownMs: 0,
      onLearned: (entries) => learned.push(...entries)
    });
    await hook.afterComplete?.(...turn("u", "I moved to Busan"));
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ key: "home_city", previousValue: "Seoul" });
  });

  it("does NOT notify on a first-time fact (a new value records no supersession)", async () => {
    const store = new InMemoryUserMemoryStore();
    const learned: FactSupersession[] = [];
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider('{"facts":{"pet":"dog"}}'),
      model: "m",
      extractionCooldownMs: 0,
      onLearned: (entries) => learned.push(...entries)
    });
    await hook.afterComplete?.(...turn("u", "my pet is a dog"));
    expect(learned).toEqual([]);
  });

  it("a learned change drives a cited confirmation line end-to-end (onLearned → formatLearnedConfirmation)", async () => {
    const store = new InMemoryUserMemoryStore();
    store.upsertFact("u", "home_city", "Seoul");
    let line: string | undefined;
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider('{"facts":{"home_city":"Busan"}}'),
      model: "m",
      extractionCooldownMs: 0,
      onLearned: (entries) => {
        const memory = store.findByUserId("u");
        line = memory ? formatLearnedConfirmation(entries, memory) : undefined;
      }
    });
    await hook.afterComplete?.(...turn("u", "I moved to Busan"));
    expect(line).toBe('📝 Got it — home city is now "Busan" (changed from "Seoul").');
  });
});

describe("createUserMemoryAutoExtractHook — FIX 1 deterministic fact-candidate backstop", () => {
  it("rescues daughter_birthday from a rambling long-form remember-request the model DROPS", async () => {
    const store = new InMemoryUserMemoryStore();
    const message =
      "우리 딸 생일이 다음달 5일인데 자꾸 까먹을까봐 걱정이예요. 요즘 나이가 들어서 그런지 이것저것 자꾸 잊어버리네요. " +
      "그래서 그러는데 혹시 이것 좀 꼭 기억했다가 알려줄수 있어요?";
    const hook = createUserMemoryAutoExtractHook({
      store,
      // Simulates the LLM pass dropping the fact in the rambling long-form
      // turn — the exact confirmed defect.
      modelProvider: fakeProvider('{"facts":{},"preferences":{},"vetoes":[],"goals":[]}'),
      model: "m",
      extractionCooldownMs: 0
    });
    await hook.afterComplete?.(...turn("u", message));
    const memory = store.findByUserId("u");
    // FIX N5b: the backstop resolves "다음달 5일" to the ABSOLUTE month at
    // extraction time (real wall clock here — no `now` injected), so a
    // "next month" string never goes stale once the calendar rolls over.
    const expectedMonth = ((new Date().getMonth() + 1) % 12) + 1;
    expect(memory?.facts?.daughter_birthday).toBe(`${expectedMonth}월 5일`);
  });

  it("does not overwrite a richer model-extracted value for the same key", async () => {
    const store = new InMemoryUserMemoryStore();
    const message = "딸 생일 다음달 5일이야 기억해줘";
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider('{"facts":{"daughter_birthday":"다음달 5일, 김민지"},"preferences":{},"vetoes":[],"goals":[]}'),
      model: "m",
      extractionCooldownMs: 0
    });
    await hook.afterComplete?.(...turn("u", message));
    const memory = store.findByUserId("u");
    expect(memory?.facts?.daughter_birthday).toBe("다음달 5일, 김민지");
  });

  it("stays silent when the message has no commit marker (no spurious fact)", async () => {
    const store = new InMemoryUserMemoryStore();
    const message = "우리 딸 생일이 다음달 5일이에요";
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider('{"facts":{},"preferences":{},"vetoes":[],"goals":[]}'),
      model: "m",
      extractionCooldownMs: 0
    });
    await hook.afterComplete?.(...turn("u", message));
    const memory = store.findByUserId("u");
    expect(memory?.facts?.daughter_birthday).toBeUndefined();
  });
});

describe("createUserMemoryAutoExtractHook — FIX 2 ephemeral value guard", () => {
  it("rejects the confirmed jiwoo case: climbing_gym_time = '오늘 저녁 7시' is never persisted as a durable fact", async () => {
    const store = new InMemoryUserMemoryStore();
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider('{"facts":{"climbing_gym_time":"오늘 저녁 7시"},"preferences":{},"vetoes":[],"goals":[]}'),
      model: "m",
      extractionCooldownMs: 0
    });
    await hook.afterComplete?.(...turn("u", "오늘 저녁 7시에 클라이밍장 가요"));
    const memory = store.findByUserId("u");
    expect(memory?.facts?.climbing_gym_time).toBeUndefined();
  });

  it("keeps an absolute-date fact alongside a rejected ephemeral one in the same turn", async () => {
    const store = new InMemoryUserMemoryStore();
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider(
        '{"facts":{"climbing_gym_time":"오늘 저녁 7시","daughter_birthday":"8월 5일"},"preferences":{},"vetoes":[],"goals":[]}'
      ),
      model: "m",
      extractionCooldownMs: 0
    });
    await hook.afterComplete?.(...turn("u", "오늘 저녁 7시에 클라이밍장 가요, 참고로 딸 생일은 8월 5일이에요"));
    const memory = store.findByUserId("u");
    expect(memory?.facts?.climbing_gym_time).toBeUndefined();
    expect(memory?.facts?.daughter_birthday).toBe("8월 5일");
  });

  it("does not reject an ephemeral PREFERENCE (guard is scoped to facts only)", async () => {
    const store = new InMemoryUserMemoryStore();
    const hook = createUserMemoryAutoExtractHook({
      store,
      modelProvider: fakeProvider('{"facts":{},"preferences":{"mood_today":"오늘 기분 좋음"},"vetoes":[],"goals":[]}'),
      model: "m",
      extractionCooldownMs: 0
    });
    await hook.afterComplete?.(...turn("u", "오늘 기분이 좋아요"));
    const memory = store.findByUserId("u");
    expect(memory?.preferences?.mood_today).toBe("오늘 기분 좋음");
  });
});
