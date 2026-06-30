import type { ToolExemplar } from "./tool-exemplars.js";

/**
 * Seed few-shot bank that makes Programmatic Tool Calling selectable on the
 * local 12B in production. Phase 4 proved gemma4 NEVER picks the brand-new
 * `run_tool_plan` tool without exemplars (0/2) but does so reliably WITH them
 * (4/4): a multi-step / data-flow request must map to a single `run_tool_plan`
 * plan, while a single call must stay a native call and small talk must stay
 * tool-free.
 *
 * These are canonical PARAPHRASES, deliberately NOT the eval's literal test
 * prompts (the eval owns its own bank); this seed is what ships so the live
 * `muse chat/ask` prompt teaches the pattern on day one. Restraint cases
 * (`tool` = a native name or `null`) are kept so the bank doesn't bias the
 * model toward over-firing `run_tool_plan` on a single call or a greeting.
 */
export const RUN_TOOL_PLAN_EXEMPLAR_BANK: readonly ToolExemplar[] = [
  { prompt: "check today's date and then work out how many days remain until my deadline", tool: "run_tool_plan" },
  { prompt: "list my calendar events for next week and then find an open slot between them", tool: "run_tool_plan" },
  { prompt: "search my notes for the project name and then summarize the matching ones", tool: "run_tool_plan" },
  { prompt: "get the current time and use it to compute how long until midnight", tool: "run_tool_plan" },
  { prompt: "list the files in the folder and then grep each one for the error message", tool: "run_tool_plan" },
  { prompt: "find my next meeting and then draft a reminder for ten minutes before it", tool: "run_tool_plan" },
  { prompt: "what time is it right now", tool: "time_now" },
  { prompt: "add finish the quarterly report to my task list", tool: "task_add" },
  { prompt: "hey there, how is it going today", tool: null },
  { prompt: "thanks, that was really helpful", tool: null }
];
