import type {
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall
} from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  executeStreamingModelLoop,
  type ModelLoopRunner
} from "../src/model-loop.js";
import type {
  ExecutedToolResult,
  ModelLoopExecution
} from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

type PermissionResult = "allowed" | "blocked";

interface NormalizedToolLoopTrace {
  readonly outcome: string;
  readonly permissions: readonly PermissionResult[];
  readonly tools: readonly {
    readonly arguments: string;
    readonly name: string;
  }[];
}

const noopSpan = { end() {}, setAttribute() {}, setError() {} };
const timerTool = {
  description: "start a focus timer",
  inputSchema: { type: "object" as const },
  name: "timer_start",
  risk: "execute" as const
};

function scriptedProvider(
  id: string,
  turns: readonly (readonly ModelEvent[])[]
): ModelProvider {
  let turn = 0;
  return {
    generate: async () => {
      throw new Error("blocking generation is outside this streaming fixture");
    },
    id,
    listModels: async () => [],
    stream: async function* () {
      const events = turns[Math.min(turn, turns.length - 1)] ?? [];
      turn += 1;
      for (const event of events) {
        yield event;
      }
    }
  };
}

function done(
  id: string,
  model: string,
  output: string,
  toolCalls?: readonly ModelToolCall[]
): ModelEvent {
  const response: ModelResponse = {
    id,
    model,
    output,
    ...(toolCalls ? { toolCalls } : {})
  };
  return { response, type: "done" };
}

async function runFixture(
  provider: ModelProvider,
  permission: PermissionResult
): Promise<NormalizedToolLoopTrace> {
  const permissions: PermissionResult[] = [];
  let effects = 0;
  const runner: ModelLoopRunner = {
    executeToolCall: async (_context, toolCall): Promise<ExecutedToolResult> => {
      effects += 1;
      return {
        result: {
          id: toolCall.id,
          name: toolCall.name,
          output: "timer started",
          status: "completed"
        },
        toolCall
      };
    },
    maxToolCalls: 3,
    metrics: { recordTokenUsage() {} },
    toolCallMiddleware: [
      () => {
        permissions.push(permission);
        return permission === "allowed"
          ? { action: "allow" }
          : { action: "block", reason: "permission denied by fixture" };
      }
    ],
    tracer: { startSpan: () => noopSpan }
  } as ModelLoopRunner;
  const context: AgentRunContext = {
    input: {
      messages: [{ content: "Start a 25 minute focus timer.", role: "user" }],
      model: "fixture/model"
    },
    runId: `run-${provider.id}`,
    startedAt: new Date("2026-07-29T00:00:00.000Z")
  };
  const request: ModelRequest = {
    messages: context.input.messages,
    model: context.input.model,
    tools: [timerTool]
  };
  const stream = executeStreamingModelLoop(
    runner,
    context,
    provider,
    request,
    { forwardTextDeltas: true }
  );
  let next = await stream.next();
  while (!next.done) {
    next = await stream.next();
  }
  const trace = normalizeTrace(next.value, permissions);
  expect(effects).toBe(permission === "allowed" ? 1 : 0);
  return trace;
}

function normalizeTrace(
  execution: ModelLoopExecution,
  permissions: readonly PermissionResult[]
): NormalizedToolLoopTrace {
  return {
    outcome: execution.finalResponse.output,
    permissions,
    tools: execution.toolResults.map(({ toolCall }) => ({
      arguments: stableJson(toolCall.arguments),
      name: toolCall.name
    }))
  };
}

function requireProviderParity(
  left: NormalizedToolLoopTrace,
  right: NormalizedToolLoopTrace
): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("provider-neutral tool-loop trace mismatch");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function providerA(argumentsOverride?: ModelToolCall["arguments"]): ModelProvider {
  const toolCall = {
    arguments: argumentsOverride ?? { minutes: 25, room: "focus" },
    id: "openai-wire-call-91",
    name: timerTool.name
  };
  return scriptedProvider("provider-a", [
    [
      { name: timerTool.name, type: "tool-call-started" },
      { toolCall, type: "tool-call" },
      done("openai-response-1", "provider-a/model", "", [toolCall])
    ],
    [
      { text: "Timer ", type: "text-delta" },
      { text: "started.", type: "text-delta" },
      done("openai-response-2", "provider-a/model", "")
    ]
  ]);
}

function providerB(argumentsOverride?: ModelToolCall["arguments"]): ModelProvider {
  const toolCall = {
    arguments: argumentsOverride ?? { room: "focus", minutes: 25 },
    id: "anthropic-wire-call-x7",
    name: timerTool.name
  };
  return scriptedProvider("provider-b", [
    [done("anthropic-message-1", "provider-b/model", "wire-specific preface", [toolCall])],
    [done("anthropic-message-2", "provider-b/model", "Timer started.")]
  ]);
}

describe("provider-neutral normalized tool-loop trace", () => {
  it("matches outcome, tool arguments, and permission across two provider event shapes", async () => {
    const left = await runFixture(providerA(), "allowed");
    const right = await runFixture(providerB(), "allowed");

    expect(() => requireProviderParity(left, right)).not.toThrow();
    expect(left).toEqual({
      outcome: "Timer started.",
      permissions: ["allowed"],
      tools: [{
        arguments: "{\"minutes\":25,\"room\":\"focus\"}",
        name: "timer_start"
      }]
    });
  });

  it("fails parity when normalized tool arguments diverge", async () => {
    const baseline = await runFixture(providerA(), "allowed");
    const changed = await runFixture(
      providerB({ minutes: 30, room: "focus" }),
      "allowed"
    );

    expect(() => requireProviderParity(baseline, changed))
      .toThrow("provider-neutral tool-loop trace mismatch");
  });

  it("fails parity when the permission result diverges", async () => {
    const allowed = await runFixture(providerA(), "allowed");
    const blocked = await runFixture(providerB(), "blocked");

    expect(() => requireProviderParity(allowed, blocked))
      .toThrow("provider-neutral tool-loop trace mismatch");
  });
});
