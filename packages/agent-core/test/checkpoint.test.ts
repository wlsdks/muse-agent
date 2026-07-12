import { Buffer } from "node:buffer";
import type { ModelProvider, ModelResponse } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import {
  createAgentCheckpointState,
  decodeCheckpointMessages,
  encodeCheckpointMessages,
  resumeRunInputFromCheckpoint
} from "../src/checkpoint.js";
import { ModelRoutingError } from "../src/errors.js";
import { createAgentRuntime } from "../src/index.js";

const sampleMessages = [
  { content: "you are helpful", role: "system" as const },
  { content: "what time is it?", role: "user" as const },
  {
    content: "let me check",
    role: "assistant" as const,
    toolCalls: [{ arguments: { tz: "UTC" }, id: "tc-1", name: "time_now" }]
  },
  { content: "12:00 UTC", name: "time_now", role: "tool" as const, toolCallId: "tc-1" }
];

describe("encodeCheckpointMessages + decodeCheckpointMessages — round-trip contract", () => {
  it("round-trips every supported role byte-for-byte", () => {
    const encoded = encodeCheckpointMessages(sampleMessages);
    expect(encoded).toHaveLength(sampleMessages.length);
    for (let i = 0; i < encoded.length; i += 1) {
      expect(encoded[i]).toMatch(new RegExp(`^v1\\|${sampleMessages[i]!.role}\\|`, "u"));
    }
    expect(decodeCheckpointMessages(encoded)).toEqual(sampleMessages);
  });

  it("returns an empty array for an empty input (no minimum-length contract)", () => {
    expect(encodeCheckpointMessages([])).toEqual([]);
    expect(decodeCheckpointMessages([])).toEqual([]);
  });

  it("createAgentCheckpointState packages everything into a JSON-serializable state", () => {
    const state = createAgentCheckpointState({
      messages: sampleMessages,
      metadata: { runId: "r1" },
      model: "ollama/qwen3:8b",
      output: "12:00 UTC",
      phase: "tool_loop"
    });
    expect(state.phase).toBe("tool_loop");
    expect(state.model).toBe("ollama/qwen3:8b");
    expect(state.metadata).toEqual({ runId: "r1" });
    expect(state.output).toBe("12:00 UTC");
    expect(state.encodedMessages).toHaveLength(sampleMessages.length);
    // state must be losslessly stringify-able (it lives in the run store).
    expect(() => JSON.parse(JSON.stringify(state))).not.toThrow();
    expect(decodeCheckpointMessages(state.encodedMessages)).toEqual(sampleMessages);
  });

  it("createAgentCheckpointState defaults metadata + output to null when omitted", () => {
    const state = createAgentCheckpointState({
      messages: [],
      model: "ollama/qwen3:8b",
      phase: "start"
    });
    expect(state.metadata).toBeNull();
    expect(state.output).toBeNull();
  });
});

describe("decodeCheckpointMessages — every malformed shape throws ModelRoutingError, never a leaky SyntaxError or TypeError", () => {
  function encodePayload(message: unknown): string {
    return Buffer.from(JSON.stringify(message), "utf8").toString("base64");
  }

  it("rejects an unsupported version envelope (v2|… or no version prefix)", () => {
    expect(() => decodeCheckpointMessages([
      `v2|user|${encodePayload({ content: "hi", role: "user" })}`
    ])).toThrow(ModelRoutingError);
    expect(() => decodeCheckpointMessages(["ROLE:content"])).toThrow(ModelRoutingError);
  });

  it("rejects an entry with a missing role or missing payload (segments empty)", () => {
    // "v1||<payload>" — role is the empty string
    expect(() => decodeCheckpointMessages([
      `v1||${encodePayload({ content: "x", role: "user" })}`
    ])).toThrow(ModelRoutingError);
    // "v1|user|" — payload is missing
    expect(() => decodeCheckpointMessages(["v1|user|"])).toThrow(ModelRoutingError);
  });

  it("rejects a payload that is not parseable JSON (garbage base64 bytes that decode to non-JSON)", () => {
    // Buffer.from(_, "base64") is lenient and accepts random characters
    // (silently dropping ones outside the alphabet). The decoded UTF-8
    // here is unparseable JSON — the contract is "throw
    // ModelRoutingError," NOT leak the underlying SyntaxError.
    expect(() => decodeCheckpointMessages(["v1|user|notreallybase64$$"]))
      .toThrow(ModelRoutingError);
    // Same shape but with truly invalid JSON inside a valid base64.
    expect(() => decodeCheckpointMessages([
      `v1|user|${Buffer.from("not json at all", "utf8").toString("base64")}`
    ])).toThrow(ModelRoutingError);
  });

  it("rejects a payload that parses to a JSON primitive or array (not an object)", () => {
    const numberPayload = Buffer.from("42", "utf8").toString("base64");
    const stringPayload = Buffer.from("\"just a string\"", "utf8").toString("base64");
    const arrayPayload = Buffer.from("[\"role\", \"content\"]", "utf8").toString("base64");
    const nullPayload = Buffer.from("null", "utf8").toString("base64");
    for (const payload of [numberPayload, stringPayload, arrayPayload, nullPayload]) {
      expect(() => decodeCheckpointMessages([`v1|user|${payload}`])).toThrow(ModelRoutingError);
    }
  });

  it("rejects a payload object missing required fields or with wrong field types", () => {
    // Object without `role` / `content` keys.
    const emptyObjPayload = encodePayload({});
    // `role` present but unknown.
    const wrongRolePayload = encodePayload({ content: "x", role: "supervisor" });
    // `content` is a number, not a string.
    const wrongContentPayload = encodePayload({ content: 42, role: "user" });
    for (const payload of [emptyObjPayload, wrongRolePayload, wrongContentPayload]) {
      expect(() => decodeCheckpointMessages([`v1|user|${payload}`])).toThrow(ModelRoutingError);
    }
  });

  it("rejects when envelope role and payload role disagree (anti-tampering)", () => {
    // Envelope says "user", payload says "assistant" — refuse, even though
    // the payload is a valid ModelMessage on its own, because the envelope
    // role is the load-bearing index for fast filtering and must match.
    const assistantPayload = encodePayload({ content: "hi", role: "assistant" });
    expect(() => decodeCheckpointMessages([`v1|user|${assistantPayload}`])).toThrow(ModelRoutingError);
  });
});

describe("resumeRunInputFromCheckpoint — durable resume", () => {
  it("rehydrates a re-runnable input (messages + model + metadata) from a checkpoint", () => {
    const state = createAgentCheckpointState({
      messages: sampleMessages,
      metadata: { userId: "jinan" },
      model: "ollama/qwen3:8b",
      phase: "tool-loop"
    });
    const input = resumeRunInputFromCheckpoint(state, { runId: "resumed-1" });
    expect(input.model).toBe("ollama/qwen3:8b");
    expect(input.metadata).toEqual({ userId: "jinan" });
    expect(input.runId).toBe("resumed-1");
    // the saved conversation (incl. completed tool results) is replayed verbatim
    expect(input.messages).toEqual(decodeCheckpointMessages(state.encodedMessages));
    expect(input.messages).toEqual(sampleMessages);
  });

  it("omits metadata when the checkpoint had none", () => {
    const state = createAgentCheckpointState({ messages: sampleMessages, model: "m", phase: "p" });
    expect(resumeRunInputFromCheckpoint(state).metadata).toBeUndefined();
  });

  it("does not persist authority or receipt-shaped metadata, and only accepts fresh resume overrides", () => {
    const authority = createToolExposureAuthority({ allowedToolNames: ["safe.read"], localMode: true });
    const gate = () => ({ allowed: true as const });
    const state = createAgentCheckpointState({
      messages: sampleMessages,
      metadata: {
        allowedToolNames: ["unsafe.write"],
        approvalReceipt: { nonce: "receipt-1" },
        localMode: true,
        profile: "personal-work",
        toolExposureAuthority: authority as never,
        userId: "jinan"
      },
      model: "m",
      phase: "tool-loop"
    });

    expect(JSON.stringify(state)).not.toContain("unsafe.write");
    expect(JSON.stringify(state)).not.toContain("receipt-1");
    expect(JSON.stringify(state)).not.toContain("personal-work");
    expect(JSON.stringify(state)).not.toContain("toolExposureAuthority");
    expect(resumeRunInputFromCheckpoint(state).toolExposureAuthority).toBeUndefined();
    expect(resumeRunInputFromCheckpoint(state).toolApprovalGate).toBeUndefined();
    expect(resumeRunInputFromCheckpoint(state).metadata).toEqual({ userId: "jinan" });

    const resumed = resumeRunInputFromCheckpoint(state, {
      toolApprovalGate: gate,
      toolExposureAuthority: authority
    });
    expect(resumed.toolApprovalGate).toBe(gate);
    expect(resumed.toolExposureAuthority).toBe(authority);
  });

  it("requires fresh authority and a fresh gate before a resumed execute call can run", async () => {
    const state = createAgentCheckpointState({
      messages: [{ content: "resume the command", role: "user" }],
      metadata: { allowedToolNames: ["checkpoint_execute"], localMode: true },
      model: "provider/model",
      phase: "tool-loop"
    });

    const runResume = async (overrides: Parameters<typeof resumeRunInputFromCheckpoint>[1]) => {
      let executions = 0;
      let turn = 0;
      const provider: ModelProvider = {
        id: "checkpoint-provider",
        async generate(request) {
          const responses: readonly ModelResponse[] = [
            {
              id: "tool",
              model: request.model,
              output: "",
              toolCalls: [{ arguments: {}, id: "checkpoint-tool", name: "checkpoint_execute" }]
            },
            { id: "final", model: request.model, output: "resumed" }
          ];
          return responses[Math.min(turn++, responses.length - 1)]!;
        },
        async listModels() { return []; },
        async *stream() {}
      };
      const runtime = createAgentRuntime({
        modelProvider: provider,
        toolRegistry: new ToolRegistry([{
          definition: {
            description: "Execute a checkpoint test action.",
            inputSchema: { type: "object" },
            name: "checkpoint_execute",
            risk: "execute"
          },
          execute: () => {
            executions += 1;
            return "executed";
          }
        }])
      });
      await runtime.run(resumeRunInputFromCheckpoint(state, overrides));
      return executions;
    };

    expect(await runResume()).toBe(0);
    const authority = createToolExposureAuthority({ allowedToolNames: ["checkpoint_execute"], localMode: true });
    expect(await runResume({ toolExposureAuthority: authority })).toBe(0);
    expect(await runResume({
      toolApprovalGate: () => ({ allowed: true }),
      toolExposureAuthority: authority
    })).toBe(1);
  });
});

describe("encodeCheckpointMessages redacts a registered secret before base64", () => {
  it("a resolved secret in a message is masked in the decoded payload (not stored in clear)", async () => {
    const { registerSecretValue, clearSecretRegistryForTests } = await import("@muse/shared");
    clearSecretRegistryForTests();
    registerSecretValue("ckpt_secret_value_123", "TOKEN");
    const [encoded] = encodeCheckpointMessages([{ role: "user", content: "auth ckpt_secret_value_123 done" }]);
    const decoded = Buffer.from(encoded!.split("|")[2]!, "base64").toString("utf8");
    expect(decoded).not.toContain("ckpt_secret_value_123"); // raw value never survives
    expect(decoded).toContain("‹secret:TOKEN›");
    clearSecretRegistryForTests();
  });
});
