import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "@muse/agent-core";
import { createHomeActionTool, type WebActionApprovalGate } from "@muse/domain-tools";
import type { ModelProvider, ModelResponse } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

// P17 seam: the AGENT invokes the gated home_action actuator inside a
// real `createAgentRuntime` run. Confirm ⇒ the HA service call fires;
// deny ⇒ NO call.

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
  return join(mkdtempSync(join(tmpdir(), "muse-p17-home-")), "action-log.json");
}

function run(tool: ReturnType<typeof createHomeActionTool>) {
  return createAgentRuntime({
    maxToolCalls: 1,
    modelProvider: sequenceProvider([
      { id: "tool", model: "m", output: "Acting.", toolCalls: [{ arguments: { entity: "light.living_room", service: "light.turn_off" }, id: "tc-1", name: "home_action" }] },
      { id: "final", model: "m", output: "Done." }
    ]),
    toolApprovalGate: () => ({ allowed: true }),
    toolRegistry: new ToolRegistry([tool])
  }).run({ messages: [{ content: "turn off the living room lights", role: "user" }], metadata: { localMode: true }, model: "provider/model", toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["home_action"], localMode: true }) });
}

function deps(gate: WebActionApprovalGate, fetchImpl: typeof fetch) {
  return { actionLogFile: logFile(), approvalGate: gate, baseUrl: "http://ha.local:8123", fetchImpl, token: "tok", userId: "stark" };
}

describe("P17 seam — the agent invokes the gated home_action tool", () => {
  it("CONFIRM: an agent run calls home_action and the HA service call fires once", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await run(createHomeActionTool(deps(approve, fetchImpl)));
    expect(calls).toEqual(["http://ha.local:8123/api/services/light/turn_off"]);
  });

  it("DENY: the agent calls home_action but the fail-closed gate blocks it — NO call", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await run(createHomeActionTool(deps(deny, fetchImpl)));
    expect(calls).toHaveLength(0);
  });

  it("local-only remote direct-tool refusal reaches neither approval nor Home Assistant", async () => {
    const { fetchImpl, calls } = recordingFetch();
    let approvals = 0;
    const tool = createHomeActionTool({
      ...deps(approve, fetchImpl),
      approvalGate: () => {
        approvals += 1;
        return { approved: true };
      },
      localOnly: true
    });
    const result = await tool.execute(
      { entity: "light.living_room", service: "light.turn_off" },
      { runId: "local-only", userId: "stark" }
    );
    expect(result).toMatchObject({ performed: false, reason: "failed" });
    expect(approvals).toBe(0);
    expect(calls).toEqual([]);
  });
});
