import type { ModelMessage, ModelTool } from "@muse/model";

/**
 * Re-verification nudge for the multi-step fix→run loop.
 *
 * Observed on the local 12B (eval:reverify-fix): after editing a file to fix a
 * reported failure, the model "confirms" the fix by RE-READING the edited file
 * and then declares done — it does NOT re-run the test. On a task whose first
 * failure hid a second one, that leaves the second bug unfixed. This is a
 * deterministic, one-shot nudge: when the model tries to finish with an edit
 * that was never followed by a verifying run, it is prompted ONCE to re-run the
 * command before answering.
 *
 * Reflection-guard compliant: the retry is gated by the deterministic
 * "edited-but-never-ran" check below (not a blind re-ask) and fires at most once.
 */
export const REVERIFY_NUDGE =
  "You edited a file but have not re-run the test/command to confirm the fix. " +
  "A reported failure can hide a second one that only appears after the first is fixed and the test is run again. " +
  "Re-run the verifying command now and check it actually passes before you finish.";

const RUN_VERIFY_INTENT_RE =
  /\b(?:run|runs|running|re-?runs?|execute|exec|test|tests|verify|verifies|confirm|confirms|build|builds|compile|lint|typecheck)\b|실행|테스트|빌드|컴파일|검증|확인/iu;

/** The task asks the model to run / test / verify — so a re-run is expected. */
export function hasRunVerifyIntent(messages: readonly ModelMessage[]): boolean {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join(" ");
  return RUN_VERIFY_INTENT_RE.test(userText);
}

/** A verifying command is only possible if an execute-risk tool is on offer. */
export function toolsIncludeExecute(tools: readonly ModelTool[] | undefined): boolean {
  return (tools ?? []).some((tool) => tool.risk === "execute");
}

/**
 * Tracks whether the model has an edit it never verified by re-running. A
 * write-risk tool marks an unverified edit; an execute-risk tool (a run) clears
 * it. `consumeNudge` returns true AT MOST ONCE, only while an unverified edit is
 * pending and a verifying run is both expected (run intent) and possible
 * (execute tool available).
 */
export class ReverifyNudgeTracker {
  private pendingUnverifiedEdit = false;
  private nudged = false;

  recordTool(risk: string | undefined): void {
    if (risk === "write") {
      this.pendingUnverifiedEdit = true;
    } else if (risk === "execute") {
      this.pendingUnverifiedEdit = false;
    }
  }

  consumeNudge(options: { readonly hasExecuteTool: boolean; readonly runIntent: boolean }): boolean {
    if (this.nudged || !this.pendingUnverifiedEdit) {
      return false;
    }
    if (!options.hasExecuteTool || !options.runIntent) {
      return false;
    }
    this.nudged = true;
    return true;
  }
}
