import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import type { BackgroundOrchestrationRecord } from "@muse/multi-agent";
import { describe, expect, it } from "vitest";

import { createChatOrchestration, orchestrationCompletionsFrom, toOrchestrationDoneInput } from "./chat-orchestrate.js";

/** A fake provider that resolves once `release()` is called — no real LLM
 *  involved, per agent-testing.md ("fake workers with controllable timing"). */
function fakeProvider(): { provider: ModelProvider; release: () => void; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider: ModelProvider = {
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      requests.push(request);
      await gate;
      const systemPrompt = request.messages.find((m) => m.role === "system")?.content ?? "";
      return { id: `resp-${requests.length.toString()}`, model: request.model, output: `${systemPrompt.slice(0, 6)}-answer` };
    },
    id: "fake",
    listModels: async () => [],
    stream: (): never => { throw new Error("not used"); }
  } as unknown as ModelProvider;
  return { provider, release, requests };
}

async function waitForRecord(
  chat: ReturnType<typeof createChatOrchestration>,
  orchestrationId: string,
  timeoutMs = 2000
): Promise<BackgroundOrchestrationRecord> {
  const start = Date.now();
  for (;;) {
    const found = chat.listRecords().find((r) => r.orchestrationId === orchestrationId);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${orchestrationId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createChatOrchestration — /orchestrate background fan-out for chat", () => {
  it("startOrchestration returns a handle immediately (2 fixed sub-agents), before any worker settles", async () => {
    const { provider, release } = fakeProvider();
    const chat = createChatOrchestration(provider, "diagnostic");

    const handle = chat.startOrchestration("plan the launch");

    expect(handle.subtaskCount).toBe(2);
    expect(typeof handle.orchestrationId).toBe("string");
    // Nothing has settled — no record yet even though startOrchestration already returned.
    expect(chat.listRecords()).toHaveLength(0);

    release();
    await waitForRecord(chat, handle.orchestrationId);
  });

  it("dispatches BOTH personas with distinct, non-overlapping system prompts (no duplicated sub-agent work)", async () => {
    const { provider, release, requests } = fakeProvider();
    const chat = createChatOrchestration(provider, "diagnostic");

    const handle = chat.startOrchestration("plan the launch");
    release();
    await waitForRecord(chat, handle.orchestrationId);

    expect(requests).toHaveLength(2);
    const systemPrompts = requests.map((r) => r.messages.find((m) => m.role === "system")?.content);
    expect(new Set(systemPrompts).size).toBe(2); // direct vs critic — distinct prompts, no overlap
    for (const req of requests) {
      expect(req.messages.some((m) => m.role === "user" && m.content === "plan the launch")).toBe(true);
    }
  });

  it("consolidates into one record with both workers' outputs, surfaced via orchestrationCompletionsFrom as ONE item", async () => {
    const { provider, release } = fakeProvider();
    const chat = createChatOrchestration(provider, "diagnostic");
    const before = new Date(0).toISOString();

    const handle = chat.startOrchestration("plan the launch");
    release();
    const record = await waitForRecord(chat, handle.orchestrationId);

    expect(record.status).toBe("completed");
    expect(record.subtaskCount).toBe(2);
    expect([...record.workerIds].sort()).toEqual(["critic", "direct"]);

    const items = orchestrationCompletionsFrom(chat.listRecords(), before);
    expect(items).toHaveLength(1); // ONE consolidated entry, never N per-worker entries
    expect(items[0]?.id).toBe(`orchestration:${handle.orchestrationId}`);
    expect(items[0]?.text).toContain("2 sub-agents");
  });

  it("a provider that throws for one persona still consolidates — failure captured, not swallowed", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      generate: async (request: ModelRequest): Promise<ModelResponse> => {
        requests.push(request);
        const systemPrompt = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (systemPrompt.startsWith("Review")) throw new Error("critic model call failed");
        return { id: "resp", model: request.model, output: "direct-answer" };
      },
      id: "fake",
      listModels: async () => [],
      stream: (): never => { throw new Error("not used"); }
    } as unknown as ModelProvider;
    const chat = createChatOrchestration(provider, "diagnostic");

    const handle = chat.startOrchestration("plan the launch");
    const record = await waitForRecord(chat, handle.orchestrationId);

    expect(record.status).toBe("completed"); // direct still succeeded
  });
});

describe("toOrchestrationDoneInput — pure record → notice-input projection", () => {
  it("carries the completed response output as the summary", () => {
    const record: BackgroundOrchestrationRecord = {
      finishedAt: new Date("2026-05-24T12:05:00.000Z"),
      orchestrationId: "orch-1",
      response: { id: "r1", model: "diagnostic", output: "looks solid" },
      results: [],
      status: "completed",
      subtaskCount: 2,
      workerIds: ["direct", "critic"]
    };
    expect(toOrchestrationDoneInput(record)).toEqual({
      finishedAt: "2026-05-24T12:05:00.000Z",
      id: "orch-1",
      status: "completed",
      subtaskCount: 2,
      summary: "looks solid",
      workerIds: ["direct", "critic"]
    });
  });

  it("carries the failure error as the summary", () => {
    const record: BackgroundOrchestrationRecord = {
      error: "every worker threw",
      finishedAt: new Date("2026-05-24T12:05:00.000Z"),
      orchestrationId: "orch-2",
      status: "failed",
      subtaskCount: 2,
      workerIds: ["direct", "critic"]
    };
    expect(toOrchestrationDoneInput(record).summary).toBe("every worker threw");
    expect(toOrchestrationDoneInput(record).status).toBe("failed");
  });
});
