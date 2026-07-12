import { createAgentRuntime } from "@muse/agent-core";
import { GITHUB_MCP_SERVER_NAME, InMemoryMcpServerStore, McpManager, createGitHubMcpServer, withOfficialMcpRisk, type McpConnection } from "@muse/mcp";
import type { ModelProvider } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import { ToolRegistry, createDefaultToolExposurePolicy } from "@muse/tools";
import { describe, expect, it, vi } from "vitest";

/**
 * Safety capstone (outbound-safety.md rules 1, 2, 4) for the now-live
 * external official-public MCP WRITE path (wired GitHub/Notion
 * presets + withOfficialMcpRisk). It proves end-to-end — through the
 * REAL McpManager projection AND the REAL AgentRuntime toolApprovalGate
 * seam — that an external write tool (GitHub `create_issue`) NEVER
 * produces an external mutation unless the user confirms the content:
 *
 *   - deny / timeout-undeliverable / absent-consent ⇒ the transport
 *     `tools/call` that would create the issue is NEVER sent (rules 1,2),
 *   - confirmed ⇒ the write fires exactly once with the right args
 *     (the gate isn't blanket-blocking),
 *   - a read tool stays ungated (reads are free).
 *
 * The transport fake is a SPY at the connector seam only — a
 * contract-faithful `McpConnection` whose `callTool` records whether the
 * write request reached the wire. The McpManager register/connect/
 * tool-projection path and the runtime's gate are the REAL code. This is
 * NOT a fake registry.
 *
 * GitHub's remote MCP annotates `create_issue` "read" (the untrusted
 * external default); `withOfficialMcpRisk` re-stamps it `write` so the
 * runtime's gate fires. If that re-stamp were removed the deny/timeout
 * cases below would catch a SENT write — the proof is not vacuous.
 */

const exposeWriteTools = createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true });

const CREATE_ISSUE_ARGS = { body: "steps to reproduce", owner: "octo", repo: "muse", title: "Bug: crash on launch" };

function makeConnection(callTool: McpConnection["callTool"]): McpConnection {
  return {
    callTool,
    // Both annotated "read" — exactly the untrusted external-server default.
    listTools: () => [
      { description: "Get the authenticated user", inputSchema: { type: "object" }, name: "get_me", risk: "read" },
      { description: "Create a new issue", inputSchema: { type: "object" }, name: "create_issue", risk: "read" }
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
          toolCalls: [{ arguments: args, id: "tc-1", name: `${GITHUB_MCP_SERVER_NAME}.${toolName}` }]
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

async function buildTools(callTool: McpConnection["callTool"], options: { restampRisk?: boolean } = {}) {
  const manager = new McpManager(new InMemoryMcpServerStore(), {
    connector: { connect: async () => makeConnection(callTool) }
  });
  await manager.register(createGitHubMcpServer());
  await manager.connect(GITHUB_MCP_SERVER_NAME);
  const projected = manager.toMuseTools();
  // `restampRisk: false` is the RED control: skipping withOfficialMcpRisk
  // leaves create_issue at the server's "read" annotation, so the gate
  // never fires — the deny/timeout/absent tests must then catch a SENT
  // write, proving the assertions are not vacuous.
  return options.restampRisk === false ? projected : withOfficialMcpRisk(projected);
}

describe("external official-MCP write tool is fail-close draft-first (outbound-safety rules 1,2,4)", () => {
  it("the write tool projects risk=write through the real manager + withOfficialMcpRisk", async () => {
    const tools = await buildTools(vi.fn(async () => "ok"));
    const createIssue = tools.find((tool) => tool.definition.name === "github.create_issue");
    expect(createIssue?.definition.risk, "create_issue must be re-stamped state-changing").toBe("write");
  });

  it("DENIED gate ⇒ create_issue NEVER reaches the transport (no external mutation), gate saw the draft + write risk", async () => {
    const callTool = vi.fn(async () => "issue created: #42");
    const tools = await buildTools(callTool);

    const gateInputs: { risk: string; arguments: unknown }[] = [];
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("create_issue", CREATE_ISSUE_ARGS),
      toolApprovalGate: async (input) => {
        gateInputs.push({ arguments: input.toolCall.arguments, risk: input.risk });
        return input.risk === "read" ? { allowed: true } : { allowed: false, reason: "needs draft-first approval" };
      },
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Open a GitHub issue titled 'Bug: crash on launch' on octo/muse", role: "user" }],
      model: "provider/model",
      runId: "official-write-deny",
      toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["github.create_issue"] })
    });

    expect(callTool, "denied write must never reach the wire").not.toHaveBeenCalled();
    expect(gateInputs).toContainEqual({ arguments: CREATE_ISSUE_ARGS, risk: "write" });
  });

  it("a FAILING gate (timeout / undeliverable approval) is fail-close ⇒ no external mutation", async () => {
    const callTool = vi.fn(async () => "issue created: #42");
    const tools = await buildTools(callTool);
    const gateInputs: { risk: string; arguments: unknown }[] = [];

    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("create_issue", CREATE_ISSUE_ARGS),
      toolApprovalGate: async (input) => {
        gateInputs.push({ arguments: input.toolCall.arguments, risk: input.risk });
        throw new Error("approval channel timed out");
      },
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Open a GitHub issue on octo/muse", role: "user" }],
      model: "provider/model",
      runId: "official-write-timeout",
      toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["github.create_issue"] })
    });

    expect(callTool, "a gate that cannot deliver a decision must block the write").not.toHaveBeenCalled();
    expect(gateInputs).toContainEqual({ arguments: CREATE_ISSUE_ARGS, risk: "write" });
  });

  it("ABSENT consent (gate returns not-allowed without an explicit confirm) ⇒ no external mutation", async () => {
    const callTool = vi.fn(async () => "issue created: #42");
    const tools = await buildTools(callTool);
    const gateInputs: { risk: string; arguments: unknown }[] = [];

    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("create_issue", CREATE_ISSUE_ARGS),
      // No recorded consent for this send class ⇒ fail-closed: the gate
      // returns allowed:false (the absent-consent default), never letting
      // the agent's own judgement send.
      toolApprovalGate: async (input) => {
        gateInputs.push({ arguments: input.toolCall.arguments, risk: input.risk });
        return { allowed: false, reason: "no recorded scoped consent for create_issue" };
      },
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Open a GitHub issue on octo/muse", role: "user" }],
      model: "provider/model",
      runId: "official-write-absent-consent",
      toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["github.create_issue"] })
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(gateInputs).toContainEqual({ arguments: CREATE_ISSUE_ARGS, risk: "write" });
  });

  it("CONFIRMED path ⇒ create_issue fires exactly once with the right args (the gate isn't blanket-blocking)", async () => {
    const callTool = vi.fn(async () => "issue created: #42");
    const tools = await buildTools(callTool);

    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("create_issue", CREATE_ISSUE_ARGS),
      // User confirmed the exact draft content ⇒ gate allows.
      toolApprovalGate: async () => ({ allowed: true }),
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Yes, open that GitHub issue on octo/muse", role: "user" }],
      model: "provider/model",
      runId: "official-write-confirmed",
      toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["github.create_issue"] })
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("create_issue", CREATE_ISSUE_ARGS);
  });

  it("a READ tool (get_me) is NOT gated — it runs without approval", async () => {
    const callTool = vi.fn(async () => "{\"login\":\"octocat\"}");
    const tools = await buildTools(callTool);

    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider("get_me", {}),
      toolApprovalGate: async (input) =>
        input.risk === "read" ? { allowed: true } : { allowed: false, reason: "blocked" },
      toolExposurePolicy: exposeWriteTools,
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Who am I on GitHub?", role: "user" }],
      model: "provider/model",
      runId: "official-read-ungated"
    });

    expect(callTool).toHaveBeenCalledWith("get_me", {});
  });
});
