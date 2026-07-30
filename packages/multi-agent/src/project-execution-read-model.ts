import { assertPlainDataTree } from "@muse/shared";

export const PROJECT_EXECUTION_STATUSES = [
  "draft",
  "active",
  "blocked",
  "completed",
  "archived"
] as const;

export type ProjectExecutionStatus = (typeof PROJECT_EXECUTION_STATUSES)[number];

export type ProjectExecutionSource =
  | Readonly<{ readonly kind: "owner-created" }>
  | Readonly<{ readonly kind: "imported"; readonly ref: string }>;

export interface ProjectExecutionLinks {
  readonly continuityThreadIds: readonly string[];
  readonly conversationIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly outcomeIds: readonly string[];
  readonly taskIds: readonly string[];
}

export interface ProjectExecutionReadModelInput {
  readonly goal: string;
  readonly links: ProjectExecutionLinks;
  readonly owner: "user";
  readonly projectId: string;
  readonly source: ProjectExecutionSource;
  readonly status: ProjectExecutionStatus;
}

export interface ProjectExecutionReadModel extends ProjectExecutionReadModelInput {
  readonly schemaVersion: 1;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const PROJECT_ID = /^project_[A-Za-z0-9][A-Za-z0-9._:-]{0,151}$/u;
const MAX_GOAL_LENGTH = 2_000;
const MAX_LINKS_PER_KIND = 100;
const trusted = new WeakSet<object>();

/**
 * Canonical project execution identity. It contains relationship IDs only:
 * thread, evidence, outcome, and task records keep their own authority and
 * lifecycle outside this model.
 */
export function createProjectExecutionReadModel(
  input: ProjectExecutionReadModelInput
): ProjectExecutionReadModel {
  assertPlainDataTree(input, "projectExecution");
  const value = exactRecord(input, [
    "goal",
    "links",
    "owner",
    "projectId",
    "source",
    "status"
  ], "projectExecution");
  const projectId = requireProjectId(value.projectId);
  const links = parseLinks(value.links, projectId);
  const goal = requireText(value.goal, "goal", MAX_GOAL_LENGTH);
  if (value.owner !== "user") throw new TypeError("project owner must be user");
  if (!PROJECT_EXECUTION_STATUSES.includes(value.status as ProjectExecutionStatus)) {
    throw new TypeError("invalid project execution status");
  }
  const model = Object.freeze({
    goal,
    links,
    owner: "user" as const,
    projectId,
    schemaVersion: 1 as const,
    source: parseSource(value.source),
    status: value.status as ProjectExecutionStatus
  });
  trusted.add(model);
  return model;
}

/**
 * Changes project execution state only. Linked domains are immutable IDs and
 * are retained byte-for-byte; this capability cannot mutate their records.
 */
export function setProjectExecutionStatus(
  model: ProjectExecutionReadModel,
  status: ProjectExecutionStatus
): ProjectExecutionReadModel {
  if (!PROJECT_EXECUTION_STATUSES.includes(status)) {
    throw new TypeError("invalid project execution status");
  }
  const current = normalize(model);
  if (current.status === status) return current;
  const next = Object.freeze({ ...current, status });
  trusted.add(next);
  return next;
}

/** Preserve the project relationship tombstone instead of deleting linked domains. */
export function archiveProjectExecution(
  model: ProjectExecutionReadModel
): ProjectExecutionReadModel {
  return setProjectExecutionStatus(model, "archived");
}

function normalize(value: ProjectExecutionReadModel): ProjectExecutionReadModel {
  if (typeof value === "object" && value !== null && trusted.has(value)) return value;
  assertPlainDataTree(value, "projectExecution");
  const record = exactRecord(value, [
    "goal",
    "links",
    "owner",
    "projectId",
    "schemaVersion",
    "source",
    "status"
  ], "projectExecution");
  if (record.schemaVersion !== 1) throw new TypeError("project schemaVersion must be 1");
  return createProjectExecutionReadModel({
    goal: record.goal as string,
    links: record.links as ProjectExecutionLinks,
    owner: record.owner as "user",
    projectId: record.projectId as string,
    source: record.source as ProjectExecutionSource,
    status: record.status as ProjectExecutionStatus
  });
}

function parseLinks(value: unknown, projectId: string): ProjectExecutionLinks {
  const record = exactRecord(value, [
    "continuityThreadIds",
    "conversationIds",
    "evidenceIds",
    "outcomeIds",
    "taskIds"
  ], "project links");
  const links = {
    continuityThreadIds: idList(record.continuityThreadIds, "continuityThreadIds"),
    conversationIds: idList(record.conversationIds, "conversationIds"),
    evidenceIds: idList(record.evidenceIds, "evidenceIds"),
    outcomeIds: idList(record.outcomeIds, "outcomeIds"),
    taskIds: idList(record.taskIds, "taskIds")
  };
  const all = Object.values(links).flat();
  if (all.includes(projectId)) {
    throw new TypeError("projectId cannot be reused as a linked domain id");
  }
  return Object.freeze(links);
}

function idList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LINKS_PER_KIND) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const result = value.map((entry) => {
    if (typeof entry !== "string" || !SAFE_ID.test(entry)) {
      throw new TypeError(`${label} contains an invalid id`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} contains duplicate ids`);
  }
  return Object.freeze(result.sort());
}

function parseSource(value: unknown): ProjectExecutionSource {
  const record = exactRecord(
    value,
    isRecord(value) && value.kind === "imported" ? ["kind", "ref"] : ["kind"],
    "project source"
  );
  if (record.kind === "owner-created") return Object.freeze({ kind: "owner-created" });
  if (record.kind === "imported") {
    return Object.freeze({
      kind: "imported",
      ref: requireText(record.ref, "source.ref", 500)
    });
  }
  throw new TypeError("invalid project source");
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError(`${label} must contain exactly ${fields.join(", ")}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireProjectId(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_ID.test(value)) {
    throw new TypeError("projectId must use the project_ namespace");
  }
  return value;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be non-blank and at most ${maxLength.toString()} characters`);
  }
  return value.trim();
}
