import { createAgentRuntime } from "@muse/agent-core";
import { CHROME_DEVTOOLS_MCP_SERVER_NAME, InMemoryMcpServerStore, McpManager, createChromeDevToolsMcpServer, type McpConnection } from "@muse/mcp";
import type { ModelProvider } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

/**
 * P18 read-first, slice 2 — the AGENT actually answers grounded in the
 * user's live Chrome page. Slice 1 (goal 750) proved the connector +
 * tool projection; this drives the whole loop: AgentRuntime → the
 * real MCP-projected `chrome-devtools.take_snapshot` tool → the page
 * snapshot flows back into the model input → a grounded answer.
 *
 * The fake stands only at the MCP transport seam (contract-faithful);
 * the model fake GROUNDS its final answer in the tool-result message
 * it actually received, so the assertion proves the live content
 * reached the model — not a hard-coded string.
 */

const LIVE_SNAPSHOT = "Inbox (live, logged-in): 2 unread — invoice from Acme due Friday; standup at 14:00.";

function fakeChromeConnection(): McpConnection {
  return {
    callTool: async (toolName) =>
      toolName === "take_snapshot" ? LIVE_SNAPSHOT : `Error: unknown tool ${toolName}`,
    listTools: () => [
      { description: "Return a text snapshot of the live page", inputSchema: { type: "object" }, name: "take_snapshot", risk: "read" }
    ]
  };
}

// Turn 1: call the Chrome snapshot tool. Turn 2: answer grounded in the
// tool result that came back (read from the request, never hard-coded).
function groundingProvider(): ModelProvider {
  let turn = 0;
  return {
    id: "fake-grounding",
    async generate(request) {
      turn += 1;
      if (turn === 1) {
        return {
          id: "t1",
          model: request.model,
          output: "Let me look at your open tab.",
          toolCalls: [{ arguments: {}, id: "tc-1", name: `${CHROME_DEVTOOLS_MCP_SERVER_NAME}.take_snapshot` }]
        };
      }
      const toolMessage = [...request.messages].reverse().find((message) => message.role === "tool");
      return {
        id: "t2",
        model: request.model,
        output: `Here's what's on your screen — ${toolMessage?.content ?? "(no snapshot)"}`
      };
    },
    async listModels() {
      return [];
    },
    async *stream() {
      /* unused — this slice exercises run(), not stream() */
    }
  };
}

describe("P18 read-first slice 2 — the agent answers grounded in the live Chrome page", () => {
  it("invokes the projected chrome-devtools snapshot tool and grounds its answer in the live content", async () => {
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => fakeChromeConnection() }
    });
    await manager.register(createChromeDevToolsMcpServer());
    await expect(manager.connect(CHROME_DEVTOOLS_MCP_SERVER_NAME)).resolves.toBe(true);

    const toolRegistry = new ToolRegistry(manager.toMuseTools());
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: groundingProvider(),
      toolRegistry
    });

    const result = await runtime.run({
      messages: [{ content: "What's in my open inbox tab right now?", role: "user" }],
      model: "provider/model",
      runId: "p18-read-first"
    });

    // The tool the agent actually ran:
    expect(result.toolsUsed).toContain(`${CHROME_DEVTOOLS_MCP_SERVER_NAME}.take_snapshot`);
    // The answer is grounded in the LIVE page content (it reached the model input):
    expect(result.response.output).toContain("invoice from Acme due Friday");
    expect(result.response.output).toContain("standup at 14:00");
  });
});
