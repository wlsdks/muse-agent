import { randomUUID } from "node:crypto";

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

export function createRunId(prefix = "run"): string {
  return `${prefix}_${randomUUID()}`;
}
