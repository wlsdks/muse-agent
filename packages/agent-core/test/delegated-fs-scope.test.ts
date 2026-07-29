import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileWriteTool } from "@muse/fs";
import { createToolExposureAuthority } from "@muse/policy";
import { createDefaultToolExposurePolicy, ToolExecutor, ToolRegistry } from "@muse/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRuntime } from "../src/index.js";

describe("delegated fs scope — real AgentRuntime expiry race", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await rm(root, { force: true, recursive: true });
  });

  it("advertises while current, then refuses the concrete write when authority expires before execution", async () => {
    root = await mkdtemp(join(tmpdir(), "muse-fs-delegated-runtime-"));
    const target = join(root, "expired.md");
    const authority = createToolExposureAuthority({
      allowedToolNames: ["file_write"],
      expiresAt: "2030-01-01T00:00:00.000Z",
      localMode: true,
      writablePaths: [root]
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2029-12-31T23:59:59.000Z"));
    let turn = 0;
    let advertised = false;
    const provider = {
      id: "expiry-race",
      async generate(request: { readonly model: string; readonly tools?: readonly { readonly name: string }[] }) {
        turn += 1;
        if (turn === 1) {
          advertised = request.tools?.some((tool) => tool.name === "file_write") === true;
          clock.mockReturnValue(Date.parse("2030-01-01T00:00:00.000Z"));
          return {
            id: "call",
            model: request.model,
            output: "",
            toolCalls: [{
              arguments: { content: "must-not-write", path: target },
              id: "write-1",
              name: "file_write"
            }]
          };
        }
        return { id: "final", model: request.model, output: "done" };
      },
      async listModels() { return []; },
      async *stream() {}
    };
    const fileWrite = createFileWriteTool({
      approvalGate: () => ({ approved: true }),
      baseDir: root,
      roots: [root]
    });
    const registry = new ToolRegistry([fileWrite]);
    const runtime = createAgentRuntime({
      modelProvider: provider as never,
      toolApprovalGate: () => ({ allowed: true }),
      toolExecutor: new ToolExecutor({ registry }),
      toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
      toolRegistry: registry
    });

    await runtime.run({
      messages: [{ content: "write the file", role: "user" }],
      model: "test/model",
      runId: "delegated-expiry-race",
      toolExposureAuthority: authority
    });

    expect(advertised).toBe(true);
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });
});
