import { createAgentRuntime } from "@muse/agent-core";
import { CHROME_DEVTOOLS_MCP_SERVER_NAME, InMemoryMcpServerStore, McpManager, createChromeDevToolsMcpServer, withChromeDevToolsRisk, type McpConnection } from "@muse/mcp";
import type { ModelProvider } from "@muse/model";
import { ToolRegistry, createDefaultToolExposurePolicy } from "@muse/tools";
import { describe, expect, it, vi } from "vitest";

// Browser-action context: when the user asks Muse to act on the page,
// the write tool SHOULD be proposable — the approval gate (not hiding)
// is the real draft-first guard. So expose write tools and let the
// gate do its job.
const exposeWriteTools = createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true });

/**
 * P18, bullet 2 — a state-changing web action under the user's logged-in
 * Chrome is approval-gated + draft-first; a denied / failing gate
 * produces NO external effect.
 *
 * The external server reports its tools as risk "read" (unannotated —
 * the default). `withChromeDevToolsRisk` re-stamps `fill_form` to
 * "write" (fail-close), so the AgentRuntime's toolApprovalGate fires.
 * The fake `McpConnection.callTool` is a spy: if the gate denies, it
 * must NEVER be invoked (no form submitted in the real browser).
 */

function makeConnection(callTool: McpConnection["callTool"]): McpConnection {
  return {
    callTool,
    // Both reported as "read" — exactly the untrusted external-server default.
    listTools: () => [
      { description: "Snapshot the live page", inputSchema: { type: "object" }, name: "take_snapshot", risk: "read" },
      { description: "Fill and submit a form", inputSchema: { type: "object" }, name: "fill_form", risk: "read" }
    ]
  };
}

function provider(toolName: string, args: Record<string, unknown>): ModelProvider {
  let turn = 0;
  return {
    id: "fake",
    async generate(request) {
      turn += 1;
      if (turn === 1) {
        return {
          id: "t1",
          model: request.model,
          output: "Working on it.",
          toolCalls: [{ arguments: args, id: "tc-1", name: `${CHROME_DEVTOOLS_MCP_SERVER_NAME}.${toolName}` }]
        };
      }
      return { id: "t2", model: request.model, output: "Done." };
    },
    async listModels() {
      return [];
    },
    async *stream() {
      /* unused */
    }
  };
}

async function buildTools(callTool: McpConnection["callTool"]) {
  const manager = new McpManager(new InMemoryMcpServerStore(), {
    connector: { connect: async () => makeConnection(callTool) }
  });
  await manager.register(createChromeDevToolsMcpServer());
  await manager.connect(CHROME_DEVTOOLS_MCP_SERVER_NAME);
  return withChromeDevToolsRisk(manager.toMuseTools());
}

describe("P18 bullet 2 — state-changing Chrome action is gated draft-first", () => {
  it("DENIED gate → fill_form never reaches the browser (no external effect), and the gate saw the draft", async () => {
    const callTool = vi.fn(async () => "submitted");
    const tools = await buildTools(callTool);

    const fillForm = tools.find((tool) => tool.definition.name === "chrome-devtools.fill_form");
    expect(fillForm?.definition.risk, "fill_form must be re-stamped state-changing").toBe("write");

    const gateInputs: { risk: string; arguments: unknown }[] = [];
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("fill_form", { fields: { email: "a@b.com" }, submit: true }),
      toolApprovalGate: async (input) => {
        gateInputs.push({ arguments: input.toolCall.arguments, risk: input.risk });
        return input.risk === "read" ? { allowed: true } : { allowed: false, reason: "needs draft-first approval" };
      },
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Fill and submit the signup form on this page", role: "user" }],
      model: "provider/model",
      runId: "p18-gate-deny"
    });

    // Fail-close: the form was NEVER actually submitted in the browser.
    expect(callTool).not.toHaveBeenCalled();
    // Draft-first: the gate was consulted with the state-changing risk AND the exact action content.
    expect(gateInputs).toContainEqual({ arguments: { fields: { email: "a@b.com" }, submit: true }, risk: "write" });
  });

  it("a FAILING gate (timeout / undeliverable approval) is fail-close → no external effect", async () => {
    const callTool = vi.fn(async () => "submitted");
    const tools = await buildTools(callTool);

    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("fill_form", { submit: true }),
      // A gate that cannot deliver a decision (rejects/throws) must NOT
      // let the action through — the runtime treats it as fail-close.
      toolApprovalGate: async () => {
        throw new Error("approval channel timed out");
      },
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Fill and submit the signup form on this page", role: "user" }],
      model: "provider/model",
      runId: "p18-gate-timeout"
    });

    expect(callTool).not.toHaveBeenCalled();
  });

  it("read perception (take_snapshot) is NOT gated — it runs without approval", async () => {
    const callTool = vi.fn(async () => "page text");
    const tools = await buildTools(callTool);

    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("take_snapshot", {}),
      toolApprovalGate: async (input) =>
        input.risk === "read" ? { allowed: true } : { allowed: false, reason: "blocked" },
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Take a snapshot of the live page", role: "user" }],
      model: "provider/model",
      runId: "p18-gate-read"
    });

    expect(callTool).toHaveBeenCalledWith("take_snapshot", {});
  });
});
