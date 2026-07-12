import { createAgentRuntime } from "@muse/agent-core";
import { CHROME_DEVTOOLS_MCP_SERVER_NAME, InMemoryMcpServerStore, McpManager, createChromeDevToolsMcpServer, withChromeDevToolsRisk, type McpConnection } from "@muse/mcp";
import type { ModelProvider } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import { ToolRegistry, createDefaultToolExposurePolicy } from "@muse/tools";
import { describe, expect, it, vi } from "vitest";

/**
 * P18 target-completion audit (the P→P seam check). The two P18
 * bullets shipped in separate slices: read-first perception (750/751)
 * and gated state-changing action (752). This proves they COMPOSE in
 * ONE web-control flow through the whole real stack — connector →
 * McpManager.toMuseTools() → withChromeDevToolsRisk → ToolRegistry →
 * AgentRuntime + toolApprovalGate — not just each piece alone.
 */

describe("P18 audit — perceive + gated action compose in one web-control run", () => {
  it("the agent reads the live page (allowed) AND its form submit is gated (denied) in a single run", async () => {
    const callTool = vi.fn(async (toolName: string) => (toolName === "take_snapshot" ? "Signup page: email field, submit button." : "submitted"));
    const connection: McpConnection = {
      callTool,
      // External server reports BOTH as read (the untrusted default).
      listTools: () => [
        { description: "Snapshot the live page", inputSchema: { type: "object" }, name: "take_snapshot", risk: "read" },
        { description: "Fill and submit a form", inputSchema: { type: "object" }, name: "fill_form", risk: "read" }
      ]
    };

    const manager = new McpManager(new InMemoryMcpServerStore(), { connector: { connect: async () => connection } });
    await manager.register(createChromeDevToolsMcpServer());
    await manager.connect(CHROME_DEVTOOLS_MCP_SERVER_NAME);
    const tools = withChromeDevToolsRisk(manager.toMuseTools());

    const gateRisks: string[] = [];
    let turn = 0;
    const provider: ModelProvider = {
      id: "fake",
      async generate(request) {
        turn += 1;
        if (turn === 1) {
          return { id: "t1", model: request.model, output: "Reading the page.", toolCalls: [{ arguments: {}, id: "c1", name: "chrome-devtools.take_snapshot" }] };
        }
        if (turn === 2) {
          return { id: "t2", model: request.model, output: "Submitting the form.", toolCalls: [{ arguments: { email: "a@b.com" }, id: "c2", name: "chrome-devtools.fill_form" }] };
        }
        return { id: "t3", model: request.model, output: "I read the page; the form submit needs your approval." };
      },
      async listModels() { return []; },
      async *stream() { /* unused */ }
    };

    const runtime = createAgentRuntime({
      maxToolCalls: 3,
      modelProvider: provider,
      toolApprovalGate: async (input) => {
        gateRisks.push(input.risk);
        return input.risk === "read" ? { allowed: true } : { allowed: false, reason: "draft-first approval required" };
      },
      toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Read this signup page, then fill and submit the form for me", role: "user" }],
      model: "provider/model",
      runId: "p18-seam",
      toolExposureAuthority: createToolExposureAuthority({
        allowedToolNames: ["chrome-devtools.take_snapshot", "chrome-devtools.fill_form"]
      })
    });

    // Perceived: the read tool actually ran in the browser.
    expect(callTool).toHaveBeenCalledWith("take_snapshot", {});
    // Gated: the state-changing submit NEVER reached the browser.
    expect(callTool).not.toHaveBeenCalledWith("fill_form", expect.anything());
    // Both risk classes hit the gate — read allowed, write denied — in the same run.
    expect(gateRisks).toContain("read");
    expect(gateRisks).toContain("write");
  });
});
