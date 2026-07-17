import type { JsonObject, JsonValue } from "@muse/shared";

const NEGATIVE_OUTCOME_MARKERS = ["ok", "success", "sent", "performed", "completed"] as const;

/** Add an explicit coordinator success marker only to proven local task mutations. */
export function normalizeLocalTaskMutationOutcome(toolName: string, output: string | JsonValue): string | JsonValue {
  if ((toolName !== "muse.tasks.add" && toolName !== "muse.tasks.complete")
    || !output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const record = output as Record<string, unknown>;
  if (typeof record["error"] === "string" || record["blocked"] === true
    || NEGATIVE_OUTCOME_MARKERS.some((marker) => record[marker] === false)
    || !record["task"] || typeof record["task"] !== "object" || Array.isArray(record["task"])) {
    return output;
  }
  return { completed: true, result: output as JsonObject };
}
