import { createToolExposureAuthority } from "../../packages/policy/dist/index.js";

const FILE_EDIT_TOOLS = Object.freeze(["file_grep", "file_read", "file_edit"]);
const FILE_EDIT_AND_RUN_TOOLS = Object.freeze([...FILE_EDIT_TOOLS, "run_command"]);
const CALENDAR_ADD_TOOLS = Object.freeze(["muse.calendar.add"]);
const BROWSER_AGENT_TOOLS = Object.freeze(["browser_read", "browser_type", "browser_click"]);
const ALLOW_EVAL_TOOL_CALL = Object.freeze({ allowed: true });
const TOOL_PROFILES = Object.freeze({
  "browser-agent": BROWSER_AGENT_TOOLS,
  "computer-task": FILE_EDIT_TOOLS,
  "edit-run-verify": FILE_EDIT_AND_RUN_TOOLS,
  "multifile-fix": FILE_EDIT_AND_RUN_TOOLS,
  "reverify-fix": FILE_EDIT_AND_RUN_TOOLS,
  "run-command": Object.freeze(["run_command"]),
  "two-edit-fix": FILE_EDIT_AND_RUN_TOOLS,
  "tool-arg-grounding": CALENDAR_ADD_TOOLS,
});

/** Mint the exact production authority needed by one isolated live eval. */
export function createEvalToolExposureAuthority(batteryId) {
  const allowedToolNames = TOOL_PROFILES[batteryId];
  if (!allowedToolNames) {
    throw new Error(`unknown multi-step eval battery: ${String(batteryId)}`);
  }
  return createToolExposureAuthority({ allowedToolNames, localMode: true });
}

/** Eval-only approval for tools already bounded to an isolated temp fixture. */
export function allowEvalToolCall() {
  return ALLOW_EVAL_TOOL_CALL;
}
