import { MUSE_IDENTITY_CORE } from "@muse/prompts";
import { describe, expect, it } from "vitest";

import { produceCouncilReasoning, synthesizeCouncilAnswer, type CouncilModelOptions } from "../src/council-synthesis.js";

function capturing(output: string) {
  const sink: { request?: { messages: { role: string; content: string }[] } } = {};
  const modelProvider = {
    generate: async (request: typeof sink.request) => { sink.request = request; return { output }; }
  } as unknown as CouncilModelOptions["modelProvider"];
  return { modelProvider, sink };
}

describe("council-synthesis identity", () => {
  it("produceCouncilReasoning carries the shared identity core plus the member-role task", async () => {
    const { modelProvider, sink } = capturing("my take");
    await produceCouncilReasoning("what should we do?", { model: "m", modelProvider });
    const system = sink.request?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain(MUSE_IDENTITY_CORE);
    expect(system).toContain("council of AI assistants");
    expect(system).toContain("Plain text only");
  });

  it("synthesizeCouncilAnswer carries the shared identity core plus the synthesis-role task", async () => {
    const { modelProvider, sink } = capturing('{"answer":"a","contributors":["p1"]}');
    await synthesizeCouncilAnswer(
      "what should we do?",
      [{ peerId: "p1", reasoning: "do the thing" }],
      { model: "m", modelProvider }
    );
    const system = sink.request?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain(MUSE_IDENTITY_CORE);
    expect(system).toContain("synthesising a council");
    expect(system).toContain("Never invent a member id");
  });
});
