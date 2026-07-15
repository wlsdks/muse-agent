import { Buffer } from "node:buffer";
import type { ModelMessage } from "@muse/model";
import { redactSecretsInText, type JsonObject } from "@muse/shared";
import { ModelRoutingError } from "./errors.js";
import type { AgentRunInput } from "./types.js";

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

const NON_DURABLE_AUTHORITY_METADATA_KEYS = new Set([
  "allowedtoolnames",
  "approvalgate",
  "approvalreceipt",
  "authority",
  "capabilityprofile",
  "capabilityprofileid",
  "forbiddentoolnames",
  "localmode",
  "maxtools",
  "profile",
  "profileid",
  "receipt",
  "toolapprovalgate",
  "toolapprovalreceipt",
  "toolauthority",
  "toolexposureauthority",
  "workapprovalreceipt"
]);

function checkpointMetadata(metadata: JsonObject | undefined): JsonObject | undefined {
  if (!metadata) {
    return undefined;
  }
  const durableEntries = Object.entries(metadata).filter(([key]) =>
    !NON_DURABLE_AUTHORITY_METADATA_KEYS.has(key.replace(/[-_]/gu, "").toLowerCase())
  );
  return durableEntries.length > 0 ? Object.fromEntries(durableEntries) as JsonObject : undefined;
}

export function createAgentCheckpointState(input: {
  readonly phase: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly metadata?: JsonObject;
  readonly output?: string;
}): AgentCheckpointState {
  const metadata = checkpointMetadata(input.metadata);
  return {
    encodedMessages: [...encodeCheckpointMessages(input.messages)],
    metadata: metadata ?? null,
    model: input.model,
    output: input.output ?? null,
    phase: input.phase
  };
}

/**
 * Rehydrate a re-runnable `AgentRunInput` from a persisted checkpoint — durable
 * resume. The checkpoint already holds the messages-so-far (including completed
 * tool results), so re-running continues where the interrupted/crashed run left
 * off rather than restarting; already-done tools aren't re-executed because
 * their results are in the replayed messages. Pure (decode + assemble); the
 * caller (CLI / job worker) then calls `runtime.run(input)`.
 */
export function resumeRunInputFromCheckpoint(
  state: AgentCheckpointState,
  overrides: Partial<Pick<AgentRunInput, "runId" | "signal" | "toolApprovalGate" | "toolExposureAuthority">> = {}
): AgentRunInput {
  return {
    messages: decodeCheckpointMessages(state.encodedMessages),
    model: state.model,
    ...(state.metadata ? { metadata: state.metadata } : {}),
    ...overrides
  };
}

export function encodeCheckpointMessages(messages: readonly ModelMessage[]): readonly string[] {
  return messages.map((message) => {
    // Redact any registered SecretSource value BEFORE base64-encoding — else a secret that reached
    // a message/tool-result would survive in clear inside the durable checkpoint (the encoding hides
    // it from a text scan, so it must be masked at the source).
    const payload = Buffer.from(redactSecretsInText(JSON.stringify(message)), "utf8").toString("base64");
    return `v1|${message.role}|${payload}`;
  });
}

export function decodeCheckpointMessages(encoded: readonly string[]): readonly ModelMessage[] {
  return encoded.map((entry) => {
    const [version, role, payload] = entry.split("|");

    if (version !== "v1" || !role || !payload) {
      throw new ModelRoutingError("Unsupported checkpoint message encoding");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as unknown;
    } catch {
      // `Buffer.from(_, "base64")` is lenient and silently ignores non-
      // base64 chars, so a corrupt payload yields garbled bytes that
      // `JSON.parse` then rejects with a SyntaxError. Callers contract
      // is "any bad checkpoint throws ModelRoutingError" — wrap the
      // parse fault into that single error type.
      throw new ModelRoutingError("Invalid checkpoint message payload");
    }

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
