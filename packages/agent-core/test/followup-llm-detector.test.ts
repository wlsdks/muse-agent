import { describe, expect, it, vi } from "vitest";
import { isErrorLike } from "@muse/shared";

import {
  LLM_FOLLOWUP_FUTURE_HORIZON_MS,
  LLM_FOLLOWUP_PAST_TOLERANCE_MS,
  extractFollowupPromisesLlm
} from "../src/followup-llm-detector.js";
import type { ModelProvider } from "@muse/model";

function stubProvider(output: string | Error): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async () => {
      if (isErrorLike(output)) throw output;
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
      modelProvider: stubProvider(wrapped),
      now: new Date("2026-05-13T13:00:00Z")
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.originalText).toBe("I'll check at 3pm");
  });

  it("dedupes by minute precision so a model emitting same time twice → one entry", async () => {
    const provider = stubProvider(JSON.stringify([
      { originalText: "ping at 3pm", scheduledForIso: "2026-05-13T15:00:00Z" },
      { originalText: "ping at three pm", scheduledForIso: "2026-05-13T15:00:30Z" }
    ]));
    const result = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: provider,
      now: new Date("2026-05-13T13:00:00Z")
    });
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

  it("drops a hallucinated past timestamp (more than the 5-min tolerance before anchor) so a confused model emitting yesterday's date doesn't fire a follow-up the daemon already missed", async () => {
    const provider = stubProvider(JSON.stringify([
      { originalText: "I will ping you yesterday", scheduledForIso: "2026-05-12T13:00:00Z" },
      { originalText: "I will ping you in 10 min", scheduledForIso: "2026-05-13T13:10:00Z" }
    ]));
    const result = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: provider,
      now: new Date("2026-05-13T13:00:00Z")
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.originalText).toBe("I will ping you in 10 min");
  });

  it("drops a hallucinated far-future timestamp (beyond the 365-day horizon) so a confused model emitting year 9999 doesn't litter the store with a follow-up that never fires", async () => {
    const provider = stubProvider(JSON.stringify([
      { originalText: "annual review", scheduledForIso: "9999-12-31T23:59:59Z" },
      { originalText: "next week's standup", scheduledForIso: "2026-05-20T10:00:00Z" }
    ]));
    const result = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: provider,
      now: new Date("2026-05-13T13:00:00Z")
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.originalText).toBe("next week's standup");
  });

  it("keeps a timestamp inside the 5-min past tolerance so an LLM that takes a few minutes to respond doesn't lose a fast-resolving promise", async () => {
    const provider = stubProvider(JSON.stringify([
      { originalText: "I'll ping in a moment", scheduledForIso: "2026-05-13T12:57:00Z" }
    ]));
    const result = await extractFollowupPromisesLlm("turn", {
      model: "stub",
      modelProvider: provider,
      now: new Date("2026-05-13T13:00:00Z")
    });
    expect(result).toHaveLength(1);
  });

  it("exports sensible past-tolerance and future-horizon defaults so callers reading the constants align with the runtime check", () => {
    expect(LLM_FOLLOWUP_PAST_TOLERANCE_MS).toBe(5 * 60_000);
    expect(LLM_FOLLOWUP_FUTURE_HORIZON_MS).toBe(365 * 86_400_000);
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

