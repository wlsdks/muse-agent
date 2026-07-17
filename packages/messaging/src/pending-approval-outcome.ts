export type PendingApprovalToolOutcome = "succeeded" | "unknown";

const OUTCOME_MARKERS = ["ok", "success", "sent", "performed", "completed"] as const;

/** Classify untrusted tool output conservatively; explicit failure always wins. */
export function classifyPendingApprovalToolOutcome(value: unknown): PendingApprovalToolOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "unknown";
  }
  try {
    const record = value as Record<string, unknown>;
    if ((typeof record["error"] === "string" && record["error"].length > 0)
      || OUTCOME_MARKERS.some((marker) => record[marker] === false)) {
      return "unknown";
    }
    return OUTCOME_MARKERS.some((marker) => record[marker] === true) ? "succeeded" : "unknown";
  } catch {
    return "unknown";
  }
}
