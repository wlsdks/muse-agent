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
