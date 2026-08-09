import type { JsonObject, JsonValue } from "@muse/shared";

const NEGATIVE_OUTCOME_MARKERS = ["ok", "success", "sent", "performed", "completed"] as const;
const PROOF_FIELD_BY_TOOL = {
  "muse.followup.cancel": "followup",
  "muse.followup.snooze": "followup",
  "muse.tasks.add": "task",
  "muse.tasks.complete": "task"
} as const;

/** Add an explicit coordinator success marker only to proven local task/followup mutations. */
export function normalizeLocalTaskMutationOutcome(toolName: string, output: string | JsonValue): string | JsonValue {
  const proofField = PROOF_FIELD_BY_TOOL[toolName as keyof typeof PROOF_FIELD_BY_TOOL];
  if (!proofField || !output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const record = output as Record<string, unknown>;
  if (typeof record["error"] === "string" || record["blocked"] === true
    || NEGATIVE_OUTCOME_MARKERS.some((marker) => record[marker] === false)
    || !record[proofField] || typeof record[proofField] !== "object" || Array.isArray(record[proofField])) {
    return output;
  }
  return { completed: true, result: output as JsonObject };
}
