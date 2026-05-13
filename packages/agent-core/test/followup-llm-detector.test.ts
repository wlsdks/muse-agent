import { describe, expect, it, vi } from "vitest";

import { extractFollowupPromisesLlm } from "../src/followup-llm-detector.js";
import type { ModelProvider } from "@muse/model";

function stubProvider(output: string | Error): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async () => {
      if (output instanceof Error) throw output;
      return { id: "x", model: "x", output };
    },
    stream: async function* () { /* not used */ }
  };
}

describe("extractFollowupPromisesLlm", () => {
  it("returns [] for empty text without calling the model", async () => {
    const provider = stubProvider("[]");
    const spy = vi.spyOn(provider, "generate");
    const result = await extractFollowupPromisesLlm("   ", { model: "stub", modelProvider: provider });
    expect(result).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("parses a canonical JSON-array response into FollowupPromise[]", async () => {
    const provider = stubProvider(JSON.stringify([
      { kind: "conditional", originalText: "Once the build passes I'll let you know", scheduledForIso: "2026-05-13T15:00:00Z" },
      { kind: "soft-recap", originalText: "circle back this evening", scheduledForIso: "2026-05-13T19:00:00Z" }
    ]));
    const result = await extractFollowupPromisesLlm("placeholder turn", {
      model: "stub",
      modelProvider: provider,
      now: new Date("2026-05-13T13:00:00Z")
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.scheduledFor.toISOString()).toBe("2026-05-13T15:00:00.000Z");
    expect(result[0]!.confidence).toBe("low");
    expect(result[0]!.originalText).toContain("Once the build passes");
  });

  it("tolerates prose wrapping around the JSON array (extracts the first balanced block)", async () => {
    const wrapped =
      "Sure, here's what I found:\n\n" +
      JSON.stringify([{ originalText: "I'll check at 3pm", scheduledForIso: "2026-05-13T15:00:00Z" }]) +
      "\n\nHope that helps!";
    const result = await extractFollowupPromisesLlm("placeholder turn", {
      model: "stub",
      modelProvider: stubProvider(wrapped)
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.originalText).toBe("I'll check at 3pm");
  });

  it("dedupes by minute precision so a model emitting same time twice → one entry", async () => {
    const provider = stubProvider(JSON.stringify([
      { originalText: "ping at 3pm", scheduledForIso: "2026-05-13T15:00:00Z" },
      { originalText: "ping at three pm", scheduledForIso: "2026-05-13T15:00:30Z" }
    ]));
    const result = await extractFollowupPromisesLlm("turn", { model: "stub", modelProvider: provider });
    expect(result).toHaveLength(1);
  });

  it("fail-soft on model error / empty output / malformed JSON / wrong shape", async () => {
    const onError = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: stubProvider(new Error("network down"))
    });
    expect(onError).toEqual([]);

    const onEmpty = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: stubProvider("   ")
    });
    expect(onEmpty).toEqual([]);

    const onBadJson = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: stubProvider("[not valid json")
    });
    expect(onBadJson).toEqual([]);

    const onWrongShape = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: stubProvider(JSON.stringify({ promises: [] }))
    });
    expect(onWrongShape).toEqual([]);

    const onUnparseableDate = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: stubProvider(JSON.stringify([
        { originalText: "tomorrow-ish", scheduledForIso: "not-a-date" }
      ]))
    });
    expect(onUnparseableDate).toEqual([]);
  });

  it("includes the anchor time in the user message so relative phrases stay deterministic", async () => {
    let seenUser = "";
    const provider: ModelProvider = {
      id: "spy",
      listModels: async () => [],
      generate: async (req) => {
        seenUser = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { id: "x", model: "x", output: "[]" };
      },
      stream: async function* () { /* not used */ }
    };
    await extractFollowupPromisesLlm("turn", {
      model: "spy",
      modelProvider: provider,
      now: new Date("2026-05-13T08:00:00Z")
    });
    expect(seenUser).toContain("Anchor time: 2026-05-13T08:00:00.000Z");
    expect(seenUser).toContain("turn");
  });
});
