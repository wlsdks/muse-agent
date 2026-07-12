import { createAgentRuntime } from "@muse/agent-core";
import { resolveToolExposureAuthority } from "@muse/policy";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  createTrustedAskToolExposureAuthority,
  createTrustedAskToolRun,
  TRUSTED_CLI_NOTES_READ_TOOL_ALLOWLIST,
  TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS,
  TRUSTED_CLI_PERSONAL_READ_TOOL_ALLOWLIST
} from "./trusted-local-cli-authority.js";

describe("trusted local CLI authority", () => {
  it("issues no authority at all without --with-tools", () => {
    expect(createTrustedAskToolRun({ withTools: false })).toBeUndefined();
    expect(createTrustedAskToolRun({})).toBeUndefined();
  });

  it("issues a fresh, static, unscoped personal-read token without accepting environment or request authority", () => {
    process.env.MUSE_ASK_MAX_TOOLS = "999";
    const first = createTrustedAskToolExposureAuthority();
    const second = createTrustedAskToolExposureAuthority();

    expect(first).not.toBe(second);
    expect(TRUSTED_CLI_PERSONAL_READ_TOOL_ALLOWLIST).toEqual([
      "muse.notes.list", "muse.notes.read", "muse.notes.search",
      "muse.tasks.list", "muse.tasks.search",
      "muse.calendar.providers", "muse.calendar.list",
      "muse.calendar.availability", "muse.calendar.conflicts",
      "muse.reminders.list", "muse.reminders.search"
    ]);
    expect(TRUSTED_CLI_NOTES_READ_TOOL_ALLOWLIST).toEqual([
      "muse.notes.list", "muse.notes.read", "muse.notes.search"
    ]);
    expect(TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS).toBe(7);
    expect(resolveToolExposureAuthority(first)).toEqual({
      allowedToolNames: TRUSTED_CLI_PERSONAL_READ_TOOL_ALLOWLIST,
      localMode: false
    });
    expect(resolveToolExposureAuthority(createTrustedAskToolExposureAuthority({ notesOnly: true }))).toEqual({
      allowedToolNames: TRUSTED_CLI_NOTES_READ_TOOL_ALLOWLIST,
      localMode: false
    });
    const firstRun = createTrustedAskToolRun({ withTools: true });
    const secondRun = createTrustedAskToolRun({ notesOnly: true, withTools: true });
    expect(firstRun?.maxTools).toBe(7);
    expect(firstRun?.toolExposureAuthority).not.toBe(secondRun?.toolExposureAuthority);
    expect(resolveToolExposureAuthority(secondRun?.toolExposureAuthority)).toEqual({
      allowedToolNames: TRUSTED_CLI_NOTES_READ_TOOL_ALLOWLIST,
      localMode: false
    });
    delete process.env.MUSE_ASK_MAX_TOOLS;
  });

  it("cannot expose a prohibited name or an allowlisted name once that tool becomes local-scoped", async () => {
    const exposed: string[][] = [];
    const runtime = createAgentRuntime({
      modelProvider: {
        async generate(request) {
          exposed.push((request.tools ?? []).map((tool) => tool.name));
          return { id: "response", model: request.model, output: "done" };
        },
        id: "test",
        async listModels() { return []; },
        async *stream() { yield { response: { id: "response", model: "test-model", output: "done" }, type: "done" as const }; }
      },
      toolRegistry: new ToolRegistry([
        {
          definition: { description: "List notes.", inputSchema: { type: "object" }, name: "muse.notes.list", risk: "read" },
          execute: async () => ({})
        },
        {
          definition: { description: "Read a local note.", inputSchema: { type: "object" }, name: "muse.notes.read", risk: "read", scopes: ["local"] },
          execute: async () => ({})
        },
        {
          definition: { description: "Run a shell command.", inputSchema: { type: "object" }, name: "shell_execute", risk: "execute" },
          execute: async () => ({})
        }
      ])
    });

    await runtime.run({
      messages: [{ content: "list my notes", role: "user" }],
      metadata: {
        allowedToolNames: ["shell_execute"],
        localMode: true,
        maxTools: 999
      },
      model: "test-model",
      toolExposureAuthority: createTrustedAskToolExposureAuthority()
    });

    expect(exposed).toEqual([["muse.notes.list"]]);
  });
});
