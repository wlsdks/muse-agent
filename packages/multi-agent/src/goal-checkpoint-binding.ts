const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const EFFECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_PENDING_EFFECTS = 20;

export interface GoalCheckpointBinding {
  readonly pendingEffectIds: readonly string[];
  readonly planDigest: string;
  readonly schemaVersion: 1;
}

export interface GoalCheckpointBindingInput {
  readonly pendingEffectIds: readonly string[];
  readonly planDigest: string;
}

export type GoalCheckpointResumeDecision =
  | {
      readonly decision: "refused";
      readonly reason: "plan-mismatch" | "pending-effect-mismatch";
    }
  | {
      readonly decision: "resume-ready";
      readonly pendingEffectIds: readonly string[];
      readonly planDigest: string;
    };

function ownData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`${label} must be an own data property`);
  }
  return descriptor.value;
}

function assertExactPlainShape(value: object, keys: readonly string[], label: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} prototype must be plain or null`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error(`${label} shape must contain exactly ${keys.join(", ")}`);
  }
}

function planDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new Error("planDigest must be a lowercase sha256 digest");
  }
  return value;
}

function pendingEffectIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("pendingEffectIds must be an array");
  const length = ownData(value, "length", "pendingEffectIds.length");
  if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > MAX_PENDING_EFFECTS) {
    throw new Error(`pendingEffectIds length must be between 0 and ${MAX_PENDING_EFFECTS.toString()}`);
  }
  const ids: string[] = [];
  for (let index = 0; index < Number(length); index += 1) {
    const entry = ownData(value, index.toString(), `pendingEffectIds[${index.toString()}]`);
    if (typeof entry !== "string" || !EFFECT_ID.test(entry)) {
      throw new Error(`pendingEffectIds[${index.toString()}] must be a valid exact effect id`);
    }
    ids.push(entry);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("pendingEffectIds contains duplicate ids");
  }
  return Object.freeze(ids.sort());
}

/**
 * Bind a checkpoint to one exact plan and canonical pending-effect set.
 */
export function createGoalCheckpointBinding(
  input: GoalCheckpointBindingInput
): GoalCheckpointBinding {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("checkpoint binding input must be an object");
  }
  assertExactPlainShape(input, ["pendingEffectIds", "planDigest"], "checkpoint binding input");
  return Object.freeze({
    pendingEffectIds: pendingEffectIds(
      ownData(input, "pendingEffectIds", "pendingEffectIds")
    ),
    planDigest: planDigest(ownData(input, "planDigest", "planDigest")),
    schemaVersion: 1
  });
}

function canonicalBinding(value: GoalCheckpointBinding): GoalCheckpointBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("checkpoint binding must be an object");
  }
  assertExactPlainShape(
    value,
    ["pendingEffectIds", "planDigest", "schemaVersion"],
    "checkpoint binding"
  );
  if (ownData(value, "schemaVersion", "checkpoint.schemaVersion") !== 1) {
    throw new Error("checkpoint schemaVersion must be 1");
  }
  return createGoalCheckpointBinding({
    pendingEffectIds: pendingEffectIds(
      ownData(value, "pendingEffectIds", "checkpoint.pendingEffectIds")
    ),
    planDigest: planDigest(ownData(value, "planDigest", "checkpoint.planDigest"))
  });
}

/**
 * Compare the checkpoint against current resume inputs. A match is only
 * `resume-ready`; actual execution still belongs to later authority gates.
 */
export function assessGoalCheckpointResume(
  binding: GoalCheckpointBinding,
  current: GoalCheckpointBindingInput
): GoalCheckpointResumeDecision {
  const canonical = canonicalBinding(binding);
  const expected = createGoalCheckpointBinding(current);
  if (canonical.planDigest !== expected.planDigest) {
    return Object.freeze({ decision: "refused", reason: "plan-mismatch" });
  }
  if (
    canonical.pendingEffectIds.length !== expected.pendingEffectIds.length
    || canonical.pendingEffectIds.some((id, index) => id !== expected.pendingEffectIds[index])
  ) {
    return Object.freeze({ decision: "refused", reason: "pending-effect-mismatch" });
  }
  return Object.freeze({
    decision: "resume-ready",
    pendingEffectIds: canonical.pendingEffectIds,
    planDigest: canonical.planDigest
  });
}
