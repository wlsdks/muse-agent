import { createHash } from "node:crypto";

export const TASK_ADD_OBSERVATION_SCHEMA = "muse.surface-parity.task-add-observation/v1";
export const TASK_ADD_PROJECTION_SCHEMA = "muse.surface-parity.task-add-projection/v1";

const OBSERVATION_KEYS = [
  "afterStore",
  "allowedEffectCount",
  "beforeStore",
  "resultTask",
  "scenario",
  "schemaVersion",
  "surface",
  "terminal",
];
const TASK_REQUIRED_KEYS = ["createdAt", "id", "status", "title"];
const TASK_OPTIONAL_KEYS = ["completedAt", "dueAt", "notes", "proactive", "tags", "urgent"];
const TASK_KEYS = [...TASK_REQUIRED_KEYS, ...TASK_OPTIONAL_KEYS];
const SURFACES = new Set(["api", "cli-local", "web"]);
const SCENARIOS = new Set(["empty-title", "success"]);
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Stable JSON for already-validated contract values. Object keys are sorted,
 * while array order is intentionally retained because task-store and tag order
 * are observable semantics.
 */
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("canonical JSON accepts only JSON values");
}

export function canonicalDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Convert one surface observation into the surface-neutral Task047 parity
 * projection. Collectors are deliberately outside this module: a future runner
 * may observe CLI, API, and Web independently, then submit their facts here.
 *
 * Invalid, incomplete, or unrecognized evidence never throws through as a
 * usable result. It collapses to an explicit unverified projection.
 */
export function projectTaskAddObservation(input) {
  try {
    const observation = parseObservation(input);
    const terminal = recognizeTerminal(observation);
    if (!terminal) {
      return unverifiedProjection("terminal-unrecognized", observation);
    }
    if (!effectMatchesScenario(observation)) {
      return unverifiedProjection("effect-contract-mismatch", observation);
    }

    const task = observation.resultTask === null
      ? null
      : canonicalTask(observation.resultTask);
    const beforeStore = observation.beforeStore.map(canonicalTask);
    const afterStore = observation.afterStore.map(canonicalTask);
    const beforeStoreDigest = canonicalDigest(beforeStore);
    const storeDigest = canonicalDigest(afterStore);
    const projection = {
      allowedEffectCount: observation.allowedEffectCount,
      beforeStoreDigest,
      operation: "task.add",
      reason: terminal.reason,
      scenario: observation.scenario,
      schemaVersion: TASK_ADD_PROJECTION_SCHEMA,
      storeDigest,
      task,
      terminal: terminal.terminal,
      verification: "verified",
    };
    return {
      ...projection,
      parityDigest: parityDigest(projection),
      surface: observation.surface,
    };
  } catch {
    return unverifiedProjection("malformed-observation");
  }
}

function parseObservation(input) {
  if (
    !isPlainObject(input)
    || !hasExactKeys(input, OBSERVATION_KEYS)
    || input.schemaVersion !== TASK_ADD_OBSERVATION_SCHEMA
    || !SURFACES.has(input.surface)
    || !SCENARIOS.has(input.scenario)
    || !Number.isSafeInteger(input.allowedEffectCount)
    || input.allowedEffectCount < 0
    || !Array.isArray(input.beforeStore)
    || !Array.isArray(input.afterStore)
    || (input.resultTask !== null && !isPlainObject(input.resultTask))
  ) {
    throw new TypeError("invalid task-add observation");
  }

  const beforeStore = input.beforeStore.map(parseTask);
  const afterStore = input.afterStore.map(parseTask);
  const resultTask = input.resultTask === null ? null : parseTask(input.resultTask);
  parseTerminal(input.surface, input.terminal);
  return {
    afterStore,
    allowedEffectCount: input.allowedEffectCount,
    beforeStore,
    resultTask,
    scenario: input.scenario,
    surface: input.surface,
    terminal: input.terminal,
  };
}

function parseTask(input) {
  if (
    !isPlainObject(input)
    || !hasOnlyKeys(input, TASK_KEYS)
    || !TASK_REQUIRED_KEYS.every((key) => Object.hasOwn(input, key))
    || typeof input.id !== "string"
    || input.id.length === 0
    || typeof input.title !== "string"
    || (input.status !== "open" && input.status !== "done")
    || !isInstant(input.createdAt)
    || (Object.hasOwn(input, "completedAt") && !isInstant(input.completedAt))
    || (Object.hasOwn(input, "dueAt") && !isInstant(input.dueAt))
    || (Object.hasOwn(input, "notes") && typeof input.notes !== "string")
    || (Object.hasOwn(input, "proactive") && typeof input.proactive !== "boolean")
    || (Object.hasOwn(input, "urgent") && typeof input.urgent !== "boolean")
    || (
      Object.hasOwn(input, "tags")
      && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))
    )
  ) {
    throw new TypeError("invalid persisted task");
  }
  return input;
}

function parseTerminal(surface, terminal) {
  if (!isPlainObject(terminal)) {
    throw new TypeError("invalid terminal observation");
  }
  if (
    surface === "cli-local"
    && hasExactKeys(terminal, ["exitCode", "kind", "signal"])
    && terminal.kind === "cli"
    && Number.isSafeInteger(terminal.exitCode)
    && terminal.signal === null
  ) {
    return;
  }
  if (
    surface === "api"
    && hasExactKeys(terminal, ["kind", "statusCode"])
    && terminal.kind === "http"
    && Number.isSafeInteger(terminal.statusCode)
  ) {
    return;
  }
  if (
    surface === "web"
    && hasExactKeys(terminal, ["kind", "requestCount", "submitEnabled"])
    && terminal.kind === "ui"
    && Number.isSafeInteger(terminal.requestCount)
    && terminal.requestCount >= 0
    && typeof terminal.submitEnabled === "boolean"
  ) {
    return;
  }
  throw new TypeError("terminal shape does not match its surface");
}

function recognizeTerminal(observation) {
  const { scenario, surface, terminal } = observation;
  if (scenario === "success") {
    if (surface === "cli-local" && terminal.exitCode === 0) {
      return { reason: "task-added", terminal: "success" };
    }
    if (surface === "api" && terminal.statusCode === 201) {
      return { reason: "task-added", terminal: "success" };
    }
    if (surface === "web" && terminal.submitEnabled === true && terminal.requestCount === 1) {
      return { reason: "task-added", terminal: "success" };
    }
  }
  if (scenario === "empty-title") {
    if (surface === "cli-local" && terminal.exitCode === 2) {
      return { reason: "empty-title", terminal: "user-error" };
    }
    if (surface === "api" && terminal.statusCode === 400) {
      return { reason: "empty-title", terminal: "user-error" };
    }
    if (surface === "web" && terminal.submitEnabled === false && terminal.requestCount === 0) {
      return { reason: "empty-title", terminal: "user-error" };
    }
  }
  return undefined;
}

function effectMatchesScenario(observation) {
  if (observation.scenario === "empty-title") {
    return observation.allowedEffectCount === 0
      && observation.resultTask === null
      && canonicalJson(observation.beforeStore) === canonicalJson(observation.afterStore);
  }
  if (
    observation.allowedEffectCount !== 1
    || observation.resultTask === null
    || observation.afterStore.length !== observation.beforeStore.length + 1
  ) {
    return false;
  }
  const appended = observation.afterStore.at(-1);
  return canonicalJson(observation.beforeStore)
      === canonicalJson(observation.afterStore.slice(0, -1))
    && canonicalJson(observation.resultTask) === canonicalJson(appended);
}

function canonicalTask(task) {
  return {
    completedAt: Object.hasOwn(task, "completedAt") ? task.completedAt : null,
    dueAt: Object.hasOwn(task, "dueAt") ? task.dueAt : null,
    notes: Object.hasOwn(task, "notes") ? task.notes : null,
    proactive: Object.hasOwn(task, "proactive") ? task.proactive : null,
    status: task.status,
    tags: Object.hasOwn(task, "tags") ? [...task.tags] : null,
    title: task.title,
    urgent: Object.hasOwn(task, "urgent") ? task.urgent : null,
  };
}

function unverifiedProjection(reason, observation) {
  let allowedEffectCount = null;
  let beforeStoreDigest = null;
  let storeDigest = null;
  let surface = null;
  if (observation) {
    allowedEffectCount = observation.allowedEffectCount;
    beforeStoreDigest = canonicalDigest(observation.beforeStore.map(canonicalTask));
    storeDigest = canonicalDigest(observation.afterStore.map(canonicalTask));
    surface = observation.surface;
  }
  const projection = {
    allowedEffectCount,
    beforeStoreDigest,
    operation: "task.add",
    reason,
    scenario: observation?.scenario ?? null,
    schemaVersion: TASK_ADD_PROJECTION_SCHEMA,
    storeDigest,
    task: null,
    terminal: "unverified",
    verification: "unverified",
  };
  return {
    ...projection,
    parityDigest: parityDigest(projection),
    surface,
  };
}

function parityDigest(projection) {
  const { surface: _surface, parityDigest: _parityDigest, ...canonical } = projection;
  return canonicalDigest(canonical);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isInstant(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}
