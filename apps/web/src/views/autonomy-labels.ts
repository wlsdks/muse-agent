import type { Translate } from "../i18n/index.js";

// Localized labels for the Automation view's status badges. Pure + testable so
// the view holds no string-mapping logic. Unknown values fall back to the raw
// string (forward-compatible if the server adds a new status) rather than
// showing an empty badge.

export function actionResultLabel(result: string, t: Translate): string {
  switch (result) {
    case "performed":
      return t("actstatus.performed");
    case "refused":
      return t("actstatus.refused");
    case "failed":
      return t("actstatus.failed");
    default:
      return result;
  }
}

export function objectiveStatusLabel(status: string, t: Translate): string {
  switch (status) {
    case "active":
      return t("auto.status.active");
    case "done":
      return t("auto.status.done");
    default:
      return status;
  }
}
