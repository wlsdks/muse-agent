import { describe, expect, it } from "vitest";

import { extractFollowupPromisesLlm } from "../src/followup-llm-detector.js";
import type { ModelProvider } from "@muse/model";

function stubProvider(output: string): ModelProvider {
  return {
    id: "stub",
    listModels: async () => [],
    generate: async () => ({ id: "x", model: "x", output }),
    stream: async function* () { /* not used */ }
  };
}

const NOW = new Date("2026-05-13T13:00:00Z");
const PROMISE = { originalText: "I'll check at 3pm", scheduledForIso: "2026-05-13T15:00:00Z" };

async function run(output: string) {
  return extractFollowupPromisesLlm("placeholder turn", {
    model: "stub",
    modelProvider: stubProvider(output),
    now: NOW
  });
}

// extractJsonArrayBody anchored on the first `[` and (worse) ignored JSON
// strings, so a bracket in the model's preamble OR a `]` inside a promise's
// text silently dropped every followup. These pin the robust behaviour.
describe("extractFollowupPromisesLlm — brackets in prose / inside strings must not drop followups", () => {
  it("recovers the array when the preamble contains a bracket", async () => {
    const out = `Here are the promises [for today]:\n${JSON.stringify([PROMISE])}`;
    const result = await run(out);
    expect(result).toHaveLength(1);
    expect(result[0]!.originalText).toBe("I'll check at 3pm");
  });

  it("does not let a `]` inside a promise's text close the array early", async () => {
    const out = JSON.stringify([
      { originalText: "meet [boss] at 3pm] sharp", scheduledForIso: "2026-05-13T15:00:00Z" }
    ]);
    const result = await run(out);
    expect(result).toHaveLength(1);
    expect(result[0]!.originalText).toContain("meet [boss] at 3pm] sharp");
  });

  it("walks past an irrelevant valid array before the real one", async () => {
    const out = `context tags: ["urgent","later"]\n${JSON.stringify([PROMISE])}`;
    const result = await run(out);
    expect(result).toHaveLength(1);
    expect(result[0]!.originalText).toBe("I'll check at 3pm");
  });

  it("still returns [] when there is no JSON array at all", async () => {
    expect(await run("no promises found today")).toEqual([]);
    expect(await run("ranges like [1-3] but no json")).toEqual([]);
  });
});
