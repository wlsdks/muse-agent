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

/**
 * Serialize active authored-skill mutation against qualification-hold
 * activation. The hold file is the shared lock boundary: either a mutation
 * completes before activation, or activation wins and the mutation observes
 * the engaged hold. Invalid/unreadable state is always fail-close.
 */
export function createQualificationLearningActiveSkillWriteGate(
  env: MuseEnvironment
): ActiveSkillWriteGate {
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
            throw new ActiveSkillWriteBlockedError(
              "qualification-hold-unavailable",
              { cause }
            );
          }
          if (inspection.state === "active") {
            throw new ActiveSkillWriteBlockedError("qualification-hold-active");
          }
          if (inspection.state === "invalid") {
            throw new ActiveSkillWriteBlockedError("qualification-hold-invalid");
          }
          operationStarted = true;
          return operation();
        });
      } catch (cause) {
        if (cause instanceof ActiveSkillWriteBlockedError || operationStarted) {
          throw cause;
        }
        throw new ActiveSkillWriteBlockedError(
          "qualification-hold-unavailable",
          { cause }
        );
      }
    }
  };
}
