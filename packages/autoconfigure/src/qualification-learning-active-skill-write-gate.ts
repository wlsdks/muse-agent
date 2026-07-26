import {
  ActiveSkillWriteBlockedError,
  type ActiveSkillWriteGate
} from "@muse/skills";
import {
  inspectQualificationLearningHold,
  withQualificationLearningHoldLock
} from "@muse/stores";

import type { MuseEnvironment } from "./index.js";
import { resolveQualificationLearningHoldFile } from "./provider-paths.js";

export type QualificationLearningWriteBlockReason =
  | "qualification-hold-active"
  | "qualification-hold-invalid"
  | "qualification-hold-unavailable";

export class QualificationLearningWriteBlockedError extends Error {
  readonly code = "MUSE_QUALIFICATION_LEARNING_WRITE_BLOCKED";
  readonly reason: QualificationLearningWriteBlockReason;

  constructor(reason: QualificationLearningWriteBlockReason, options?: ErrorOptions) {
    super(`active learning mutation blocked: ${reason}`, options);
    this.name = "QualificationLearningWriteBlockedError";
    this.reason = reason;
  }
}

export interface QualificationLearningWriteGate {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Serialize one active learning mutation against qualification-hold
 * activation. The hold file is the shared lock boundary: either a mutation
 * completes before activation, or activation wins and the mutation observes
 * the engaged hold. Invalid/unreadable state is always fail-close.
 */
export function createQualificationLearningWriteGate(
  env: MuseEnvironment
): QualificationLearningWriteGate {
  const file = resolveQualificationLearningHoldFile(env);
  return {
    run: async <T>(operation: () => Promise<T>): Promise<T> => {
      let operationStarted = false;
      try {
        return await withQualificationLearningHoldLock(file, async () => {
          let inspection: Awaited<ReturnType<typeof inspectQualificationLearningHold>>;
          try {
            inspection = await inspectQualificationLearningHold(file);
          } catch (cause) {
            throw new QualificationLearningWriteBlockedError(
              "qualification-hold-unavailable",
              { cause }
            );
          }
          if (inspection.state === "active") {
            throw new QualificationLearningWriteBlockedError("qualification-hold-active");
          }
          if (inspection.state === "invalid") {
            throw new QualificationLearningWriteBlockedError("qualification-hold-invalid");
          }
          operationStarted = true;
          return operation();
        });
      } catch (cause) {
        if (cause instanceof QualificationLearningWriteBlockedError || operationStarted) {
          throw cause;
        }
        throw new QualificationLearningWriteBlockedError(
          "qualification-hold-unavailable",
          { cause }
        );
      }
    }
  };
}

/** Backward-compatible authored-skill adapter with its established error code. */
export function createQualificationLearningActiveSkillWriteGate(
  env: MuseEnvironment
): ActiveSkillWriteGate {
  const gate = createQualificationLearningWriteGate(env);
  return {
    run: async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await gate.run(operation);
      } catch (cause) {
        if (cause instanceof QualificationLearningWriteBlockedError) {
          throw new ActiveSkillWriteBlockedError(cause.reason, { cause });
        }
        throw cause;
      }
    }
  };
}
