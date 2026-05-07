import { Buffer } from "node:buffer";
import type { ModelMessage } from "@muse/model";
import type { JsonObject } from "@muse/shared";
import { ModelRoutingError } from "./errors.js";

/**
 * Checkpoint state types and message codec.
 *
 * `AgentCheckpointState` is the JSON-serializable snapshot AgentRuntime
 * persists at each phase boundary so a run can be replayed or audited
 * after a crash. Messages are base64-encoded with a `v1|<role>|<payload>`
 * envelope so the role survives even if downstream stores normalize JSON
 * keys, and the version tag lets future codec changes upgrade safely.
 */

export interface AgentCheckpointState extends JsonObject {
  readonly phase: string;
  readonly model: string;
  readonly encodedMessages: string[];
  readonly metadata: JsonObject | null;
  readonly output: string | null;
}

export function createAgentCheckpointState(input: {
  readonly phase: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly metadata?: JsonObject;
  readonly output?: string;
}): AgentCheckpointState {
  return {
    encodedMessages: [...encodeCheckpointMessages(input.messages)],
    metadata: input.metadata ?? null,
    model: input.model,
    output: input.output ?? null,
    phase: input.phase
  };
}

export function encodeCheckpointMessages(messages: readonly ModelMessage[]): readonly string[] {
  return messages.map((message) => {
    const payload = Buffer.from(JSON.stringify(message), "utf8").toString("base64");
    return `v1|${message.role}|${payload}`;
  });
}

export function decodeCheckpointMessages(encoded: readonly string[]): readonly ModelMessage[] {
  return encoded.map((entry) => {
    const [version, role, payload] = entry.split("|");

    if (version !== "v1" || !role || !payload) {
      throw new ModelRoutingError("Unsupported checkpoint message encoding");
    }

    const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as unknown;

    if (!isModelMessage(parsed) || parsed.role !== role) {
      throw new ModelRoutingError("Invalid checkpoint message payload");
    }

    return parsed;
  });
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.content !== "string") {
    return false;
  }
  return record.role === "system" || record.role === "user" || record.role === "assistant" || record.role === "tool";
}
