import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  FileLocalModelExecutionLeaseCoordinator,
  LocalModelExecutionLeaseError,
  type LocalModelExecutionLease,
  type LocalModelExecutionLeaseOptions
} from "@muse/stores";

export const RESIDENT_WRITER_LEASE_REASON = {
  contended: "resident-writer-already-active",
  stateUnavailable: "resident-writer-lease-state-unavailable"
} as const;

export type ResidentWriterLeaseReasonCode =
  (typeof RESIDENT_WRITER_LEASE_REASON)[keyof typeof RESIDENT_WRITER_LEASE_REASON];

export class ResidentWriterLeaseError extends Error {
  readonly code: ResidentWriterLeaseReasonCode;

  constructor(code: ResidentWriterLeaseReasonCode) {
    super(code);
    this.name = "ResidentWriterLeaseError";
    this.code = code;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface ResidentWriterLease {
  readonly acquiredAtMs: number;
  readonly generation: string;
  readonly leaseSequence: number;
  readonly pid: number;
  readonly waitMs: number;
  validate(): Promise<boolean>;
  release(): Promise<void>;
}

export interface AcquireResidentWriterLeaseOptions {
  /** Deterministic test seam; production uses the hardened file coordinator. */
  readonly coordinator?: Pick<FileLocalModelExecutionLeaseCoordinator, "acquire">;
  readonly coordinatorOptions?: Omit<
    LocalModelExecutionLeaseOptions,
    "backgroundWaitMs" | "root"
  >;
}

export function resolveResidentWriterLeaseRoot(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  if (!isAbsolute(home) || home.includes("\0")) {
    throw new ResidentWriterLeaseError(RESIDENT_WRITER_LEASE_REASON.stateUnavailable);
  }
  return join(home, ".muse", "resident-writer-lease");
}

function mapLeaseError(cause: unknown): ResidentWriterLeaseError {
  if (cause instanceof LocalModelExecutionLeaseError && cause.code === "QUEUE_TIMEOUT") {
    return new ResidentWriterLeaseError(RESIDENT_WRITER_LEASE_REASON.contended);
  }
  return new ResidentWriterLeaseError(RESIDENT_WRITER_LEASE_REASON.stateUnavailable);
}

/**
 * Acquire the process-wide daemon writer authority.
 *
 * The reused coordinator persists an owner-only PID + random token + monotonic
 * sequence record, refuses live/unknown-owner takeover, reaps only a proven
 * dead owner, and makes late release owner-scoped. A daemon contender never
 * waits: exactly one process proceeds to writer construction.
 */
export async function acquireResidentWriterLease(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: AcquireResidentWriterLeaseOptions = {}
): Promise<ResidentWriterLease> {
  let coordinator: Pick<FileLocalModelExecutionLeaseCoordinator, "acquire">;
  try {
    coordinator = options.coordinator ?? new FileLocalModelExecutionLeaseCoordinator({
      ...options.coordinatorOptions,
      backgroundWaitMs: 0,
      root: resolveResidentWriterLeaseRoot(env)
    });
  } catch (cause) {
    throw mapLeaseError(cause);
  }

  let lease: LocalModelExecutionLease;
  try {
    lease = await coordinator.acquire("background");
  } catch (cause) {
    throw mapLeaseError(cause);
  }
  return {
    acquiredAtMs: lease.createdAtMs,
    generation: lease.token,
    leaseSequence: lease.sequence,
    pid: lease.pid,
    release: () => lease.release(),
    validate: () => lease.validate(),
    waitMs: lease.waitMs
  };
}
