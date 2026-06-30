import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "./index.js";

/**
 * Programmatic Tool Calling (PTC) — the ONE tool the model selects to run a multi-step plan in a
 * SINGLE inference. The model emits an ordered list of tool steps whose args may reference a prior
 * step's output by a `$binding`; Muse executes them deterministically through the SAME gated path
 * as a native call, and only the projected `result` re-enters the model's context (intermediate
 * outputs never do). The runtime ({@link AgentRuntime.executeToolCall}) intercepts this tool BEFORE
 * the executor and drives {@link executeToolPlanGated}; this `execute` handler is therefore a
 * defensive dead-end (PTC must run through the runtime so every step is gated + grounded).
 *
 * risk = "execute": a plan can call write/execute/outbound steps, so the wrapper must NEVER be
 * treated as a cacheable read (a replayed "read" would skip the per-step approval gate).
 *
 * Design + hostile review: docs/strategy/programmatic-tool-calling.md.
 */
export function createRunToolPlanTool(): MuseTool {
  return {
    definition: {
      description:
        "Run several tool calls as ONE ordered plan, passing one tool's output into the next. " +
        "Use when a task needs SEVERAL tool calls or when one tool's result feeds another tool's " +
        "argument; do NOT use for a single tool call (call that tool directly instead). Each step's " +
        "output is bound to its `as` name; a later step references it by passing the whole string " +
        "\"$<as>\" (or \"$<as>.field\") as an argument value. Only the `result` binding is returned " +
        "to you. Example — find free time around this week's events: " +
        "{\"steps\":[{\"as\":\"events\",\"tool\":\"calendar_list\",\"args\":{\"from\":\"today\",\"to\":\"next week\"}}," +
        "{\"as\":\"free\",\"tool\":\"availability\",\"args\":{\"around\":\"$events\"}}],\"result\":\"$free\"}.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          result: {
            description:
              "Which step binding to return to you, written as \"$<as>\" (e.g. \"$free\") or \"$<as>.field\". " +
              "Only this value re-enters context, so keep it small — optionally pipe ONE projection to " +
              "condense it: \"$rows | count\" (how many), \"$rows | first\", \"$rows | last\". " +
              "e.g. for \"how many free slots\" use \"$free | count\" instead of returning the whole list.",
            type: "string"
          },
          steps: {
            description:
              "Ordered tool steps. Each is {\"as\": binding name, \"tool\": another exposed tool's name (never \"run_tool_plan\"), \"args\": that tool's arguments}. An arg value that is exactly \"$<priorAs>\" is replaced by that earlier step's output.",
            items: {
              additionalProperties: false,
              properties: {
                args: {
                  description:
                    "Arguments for the tool. A value equal to \"$<priorAs>\" (or \"$<priorAs>.field\") is substituted with that earlier step's output.",
                  type: "object"
                },
                as: {
                  description: "Binding name for this step's output, e.g. \"events\". Referenced by later steps as \"$events\".",
                  type: "string"
                },
                tool: {
                  description: "Name of another exposed tool to call, e.g. \"calendar_list\". Must NOT be \"run_tool_plan\".",
                  type: "string"
                }
              },
              required: ["as", "tool", "args"],
              type: "object"
            },
            minItems: 1,
            type: "array"
          }
        },
        required: ["steps", "result"],
        type: "object"
      },
      domain: "core",
      keywords: ["plan", "chain", "multi", "step", "orchestrate", "pipeline"],
      name: "run_tool_plan",
      risk: "execute"
    },
    execute: (): JsonObject => ({
      error: "run_tool_plan must be executed by the agent runtime (gated, grounded per step), not the tool executor"
    })
  };
}
