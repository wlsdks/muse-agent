import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "@muse/agent-core";
import type { ModelProvider, ModelResponse } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { buildActuatorTools } from "./actuator-tools.js";
import type { ProgramIO } from "./program.js";

function fakeIo(): ProgramIO {
  return { stderr: () => {}, stdout: () => {} };
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: mkdtempSync(join(tmpdir(), "muse-actuators-")), ...overrides };
}

function recordingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    id: "test",
    async generate(request: { model: string }) {
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { ...response, model: request.model };
    },
    async listModels() {
      return [];
    },
    async *stream() {
      /* unused */
    }
  } as unknown as ModelProvider;
}

describe("buildActuatorTools — env-driven actuator selection", () => {
  it("exposes only web_action when no provider env is set", () => {
    const tools = buildActuatorTools({ confirmAction: async () => true, env: env(), io: fakeIo(), userId: "stark" });
    expect(tools.map((t) => t.definition.name).sort()).toEqual(["web_action"]);
  });

  it("adds email_send when MUSE_GMAIL_TOKEN is set", () => {
    const tools = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_GMAIL_TOKEN: "tok" }),
      io: fakeIo(),
      userId: "stark"
    });
    expect(tools.map((t) => t.definition.name).sort()).toEqual(["email_send", "web_action"]);
  });

  it("adds home_action only when both Home Assistant env vars are set", () => {
    const partial = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }),
      io: fakeIo(),
      userId: "stark"
    });
    expect(partial.map((t) => t.definition.name)).not.toContain("home_action");

    const full = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_HOMEASSISTANT_TOKEN: "ha-tok", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }),
      io: fakeIo(),
      userId: "stark"
    });
    expect(full.map((t) => t.definition.name).sort()).toEqual(["home_action", "web_action"]);
  });

  it("every actuator tool is execute-risk (gated, local-mode only)", () => {
    const tools = buildActuatorTools({
      confirmAction: async () => true,
      env: env({ MUSE_GMAIL_TOKEN: "tok", MUSE_HOMEASSISTANT_TOKEN: "ha-tok", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }),
      io: fakeIo(),
      userId: "stark"
    });
    for (const tool of tools) {
      expect(tool.definition.risk).toBe("execute");
    }
  });
});

describe("buildActuatorTools — the agent invokes a wired tool through its clack-confirm gate", () => {
  function runWebAction(confirmAction: () => Promise<boolean>, fetchImpl: typeof fetch) {
    const tools = buildActuatorTools({ confirmAction, env: env(), fetchImpl, io: fakeIo(), userId: "stark" });
    return createAgentRuntime({
      maxToolCalls: 1,
      modelProvider: sequenceProvider([
        {
          id: "tool",
          model: "m",
          output: "Acting.",
          toolCalls: [{ arguments: { summary: "Book a table", url: "http://example.test/book" }, id: "tc-1", name: "web_action" }]
        },
        { id: "final", model: "m", output: "Done." }
      ]),
      toolRegistry: new ToolRegistry([...tools])
    }).run({
      messages: [{ content: "book a table at 7pm", role: "user" }],
      metadata: { localMode: true },
      model: "provider/model"
    });
  }

  it("CONFIRM: the agent run fires the web request once", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await runWebAction(async () => true, fetchImpl);
    expect(calls).toEqual(["http://example.test/book"]);
  });

  it("DENY: the fail-closed clack gate blocks the agent call — no request fires", async () => {
    const { fetchImpl, calls } = recordingFetch();
    await runWebAction(async () => false, fetchImpl);
    expect(calls).toHaveLength(0);
  });
});
