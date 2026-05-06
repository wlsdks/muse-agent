import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type MuseMode = "local" | "remote";

export type RunStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export interface RunIdentity {
  readonly runId: string;
  readonly workspaceId?: string;
  readonly userId?: string;
}

export interface BoundaryViolation {
  readonly boundary: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly reason: string;
}

export interface CancellationToken {
  readonly signal: AbortSignal;
  readonly cancel: (reason?: string) => void;
  readonly throwIfCancelled: () => void;
}

export function createRunId(prefix = "run"): string {
  return `${prefix}_${randomUUID()}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(input: string | Buffer, secret: string | Buffer): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function verifyHmacSha256Hex(input: string | Buffer, signature: string, secret: string | Buffer): boolean {
  const normalized = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;

  if (!/^[0-9a-f]{64}$/iu.test(normalized)) {
    return false;
  }

  const expected = hmacSha256Hex(input, secret);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(normalized, "hex"));
}

export function formatBoundaryViolation(violation: BoundaryViolation): string {
  const details = [
    `boundary=${violation.boundary}`,
    `reason=${violation.reason}`,
    violation.expected ? `expected=${violation.expected}` : undefined,
    violation.actual ? `actual=${violation.actual}` : undefined
  ].filter((part): part is string => Boolean(part));

  return `Boundary violation: ${details.join("; ")}`;
}

export function createCancellationToken(): CancellationToken {
  const controller = new AbortController();

  return {
    cancel: (reason = "Operation cancelled") => {
      controller.abort(new Error(reason));
    },
    signal: controller.signal,
    throwIfCancelled: () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error("Operation cancelled");
      }
    }
  };
}
