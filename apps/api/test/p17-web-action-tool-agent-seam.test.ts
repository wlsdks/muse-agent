import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "@muse/agent-core";
import { createWebActionTool, type WebActionApprovalGate } from "@muse/domain-tools";
import type { ModelProvider, ModelResponse } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

// P17 seam: the AGENT invokes the gated web_action actuator inside a
// real `createAgentRuntime` run. Confirm ⇒ the request fires (recorded);
// deny ⇒ NO external effect.

function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    id: "test",
    async generate(request) {
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { ...response, model: request.model };
    },
    async listModels() { return []; },
    async *stream() { /* unused */ }
  } as unknown as ModelProvider;
}

function recordingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const approve: WebActionApprovalGate = () => ({ approved: true });
const deny: WebActionApprovalGate = () => ({ approved: false, reason: "user declined" });

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-p17-web-")), "action-log.json");
}

function run(tool: ReturnType<typeof createWebActionTool>) {
  return createAgentRuntime({
    maxToolCalls: 1,
    modelProvider: sequenceProvider([
      { id: "tool", model: "m", output: "Acting.", toolCalls: [{ arguments: { summary: "Book a table at 7pm", url: "https://book.test/reserve" }, id: "tc-1", name: "web_action" }] },
      { id: "final", model: "m", output: "Done." }
    ]),
    toolRegistry: new ToolRegistry([tool])
  }).run({ messages: [{ content: "book a table", role: "user" }], metadata: { localMode: true }, model: "provider/model" });
}

describe("P17 seam — the agent invokes the gated web_action tool", () => {
  it("CONFIRM: an agent run calls web_action and the request fires once", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await run(createWebActionTool({ actionLogFile: logFile(), approvalGate: approve, fetchImpl, lookup: async () => [{ address: "93.184.216.34", family: 4 }], userId: "stark" }));
    expect(calls).toEqual(["https://book.test/reserve"]);
  });

  it("DENY: the agent calls web_action but the fail-closed gate blocks it — NO request", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await run(createWebActionTool({ actionLogFile: logFile(), approvalGate: deny, fetchImpl, userId: "stark" }));
    expect(calls).toHaveLength(0);
  });
});
