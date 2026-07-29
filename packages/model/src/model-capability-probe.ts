import type { ModelCapabilities } from "./index.js";

export const MODEL_CAPABILITY_PROBE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MODEL_CAPABILITY_PROBE_TTL_MS = 5 * 60_000;

export type ProbedModelCapability = "supported" | "unsupported" | "unknown";

export interface ProbedModelCapabilities {
  readonly streaming: ProbedModelCapability;
  readonly structuredOutput: ProbedModelCapability;
  readonly toolCalling: ProbedModelCapability;
  readonly vision: ProbedModelCapability;
}

interface ModelCapabilityProbeBase {
  readonly adapterVersion: string;
  readonly capabilities: ProbedModelCapabilities;
  readonly modelId: string;
  readonly observedAt: string;
  readonly providerId: string;
  readonly schemaVersion: typeof MODEL_CAPABILITY_PROBE_SCHEMA_VERSION;
  readonly source: string;
  readonly validUntil: string;
}

export interface AvailableModelCapabilityProbeResult
  extends ModelCapabilityProbeBase {
  readonly limits: {
    readonly maxInputTokens?: number;
  };
  readonly status: "available";
}

export interface FailedModelCapabilityProbeResult
  extends ModelCapabilityProbeBase {
  readonly failureReason:
    | "http-error"
    | "invalid-model"
    | "invalid-response"
    | "transport-error";
  readonly status: "failed";
}

export type ModelCapabilityProbeResult =
  | AvailableModelCapabilityProbeResult
  | FailedModelCapabilityProbeResult;

export function modelCapabilityProbeIsFresh(
  probe: ModelCapabilityProbeResult,
  now: Date = new Date()
): boolean {
  if (!isRecord(probe)
    || typeof probe.observedAt !== "string"
    || typeof probe.validUntil !== "string"
    || typeof probe.adapterVersion !== "string"
    || typeof probe.modelId !== "string"
    || typeof probe.providerId !== "string"
    || typeof probe.source !== "string") {
    return false;
  }
  const observedMs = Date.parse(probe.observedAt);
  const validUntilMs = Date.parse(probe.validUntil);
  const nowMs = now.getTime();
  return Number.isFinite(observedMs)
    && Number.isFinite(validUntilMs)
    && Number.isFinite(nowMs)
    && canonicalIso(probe.observedAt, observedMs)
    && canonicalIso(probe.validUntil, validUntilMs)
    && probe.schemaVersion === MODEL_CAPABILITY_PROBE_SCHEMA_VERSION
    && probe.adapterVersion.trim().length > 0
    && probe.modelId.trim().length > 0
    && probe.providerId.trim().length > 0
    && probe.source.trim().length > 0
    && observedMs <= nowMs
    && observedMs < validUntilMs
    && nowMs < validUntilMs;
}

function canonicalIso(value: string, milliseconds: number): boolean {
  try {
    return new Date(milliseconds).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A failed, stale, or partly-unknown probe is not routing evidence. Static
 * declarations remain visible for diagnostics, but must not be promoted into
 * an effective capability set through this projection.
 */
export function projectModelCapabilitiesFromProbe(
  declared: ModelCapabilities,
  probe: ModelCapabilityProbeResult,
  now: Date = new Date()
): ModelCapabilities | undefined {
  if (!isRecord(probe)
    || probe.status !== "available"
    || !modelCapabilityProbeIsFresh(probe, now)
    || !isRecord(probe.capabilities)
    || !isRecord(probe.limits)) {
    return undefined;
  }
  const { capabilities } = probe;
  const capabilityKeys = [
    "streaming",
    "structuredOutput",
    "toolCalling",
    "vision"
  ] as const;
  if (Object.keys(capabilities).length !== capabilityKeys.length
    || capabilityKeys.some((key) => {
      const value = capabilities[key];
      return value !== "supported" && value !== "unsupported";
    })) {
    return undefined;
  }
  const maxInputTokens = probe.limits.maxInputTokens;
  if (maxInputTokens !== undefined
    && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0)) {
    return undefined;
  }
  return {
    ...declared,
    maxInputTokens: maxInputTokens === undefined
      ? declared.maxInputTokens
      : Math.min(declared.maxInputTokens, maxInputTokens),
    streaming: capabilities.streaming === "supported",
    structuredOutput: capabilities.structuredOutput === "supported",
    toolCalling: capabilities.toolCalling === "supported",
    vision: capabilities.vision === "supported"
  };
}

export function failedModelCapabilityProbe(input: {
  readonly adapterVersion: string;
  readonly failureReason: FailedModelCapabilityProbeResult["failureReason"];
  readonly modelId: string;
  readonly now: Date;
  readonly providerId: string;
  readonly source: string;
  readonly ttlMs?: number;
}): FailedModelCapabilityProbeResult {
  const { observedAt, validUntil } = probeWindow(input.now, input.ttlMs);
  return Object.freeze({
    adapterVersion: input.adapterVersion,
    capabilities: UNKNOWN_PROBED_CAPABILITIES,
    failureReason: input.failureReason,
    modelId: input.modelId,
    observedAt,
    providerId: input.providerId,
    schemaVersion: MODEL_CAPABILITY_PROBE_SCHEMA_VERSION,
    source: input.source,
    status: "failed",
    validUntil
  });
}

export function probeWindow(
  now: Date,
  requestedTtlMs?: number
): { readonly observedAt: string; readonly validUntil: string } {
  const nowMs = now.getTime();
  const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
  const ttlMs = requestedTtlMs !== undefined
    && Number.isSafeInteger(requestedTtlMs)
    && requestedTtlMs > 0
    ? requestedTtlMs
    : DEFAULT_MODEL_CAPABILITY_PROBE_TTL_MS;
  return {
    observedAt: new Date(safeNow).toISOString(),
    validUntil: new Date(safeNow + ttlMs).toISOString()
  };
}

const UNKNOWN_PROBED_CAPABILITIES = Object.freeze({
  streaming: "unknown",
  structuredOutput: "unknown",
  toolCalling: "unknown",
  vision: "unknown"
} as const);
