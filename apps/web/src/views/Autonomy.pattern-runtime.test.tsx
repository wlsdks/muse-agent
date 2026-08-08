import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AutomationUpcomingResponse, UpcomingPatternRuntimeDecision } from "../api/types.js";
import { DICTIONARIES } from "../i18n/strings.js";
import type { Translate } from "../i18n/index.js";
import { I18nProvider } from "../i18n/index.js";
import { UpcomingSections } from "./Autonomy.js";

const t = ((key: keyof typeof DICTIONARIES.en, vars?: Record<string, string | number>) => {
  let result = DICTIONARIES.en[key];
  for (const [name, value] of Object.entries(vars ?? {})) {
    result = result.replace(`{${name}}`, String(value));
  }
  return result;
}) as unknown as Translate;

const BASE: AutomationUpcomingResponse = {
  budget: null,
  digest: null,
  gateway: {
    destination: null,
    localOnly: false,
    providerId: null,
    reason: "paired-route-inspection-unavailable",
    source: null,
    status: "unconfigured"
  },
  nextReminder: null,
  patternRuntime: null,
  proactiveRuntime: null,
  scheduledJobs: []
};

const DECISIONS: Readonly<Record<UpcomingPatternRuntimeDecision, string>> = {
  "not-configured": DICTIONARIES.en["auto.upcoming.patternRuntime.decision.notConfigured"],
  "already-running": DICTIONARIES.en["auto.upcoming.patternRuntime.decision.alreadyRunning"],
  "quiet-hours": DICTIONARIES.en["auto.upcoming.patternRuntime.decision.quietHours"],
  "lock-held": DICTIONARIES.en["auto.upcoming.patternRuntime.decision.lockHeld"],
  "lock-error": DICTIONARIES.en["auto.upcoming.patternRuntime.decision.lockError"],
  "no-fireable": DICTIONARIES.en["auto.upcoming.patternRuntime.decision.noFireable"],
  fired: DICTIONARIES.en["auto.upcoming.patternRuntime.decision.fired"],
  completed: DICTIONARIES.en["auto.upcoming.patternRuntime.decision.completed"],
  error: DICTIONARIES.en["auto.upcoming.patternRuntime.decision.error"]
};

function render(data: AutomationUpcomingResponse): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <UpcomingSections data={data} locale="en-US" t={t} />
    </I18nProvider>
  );
}

describe("Upcoming pattern runtime card", () => {
  it("renders null as an explicit not-configured warning", () => {
    const html = render(BASE);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.patternRuntime.noObservation"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.patternRuntime.decision.notConfigured"]);
  });

  it.each(Object.entries(DECISIONS))("maps %s to localized copy", (decision, copy) => {
    const html = render({
      ...BASE,
      patternRuntime: {
        lastDecision: decision as UpcomingPatternRuntimeDecision,
        lastObservedAtIso: "not-a-date",
        lastFireableCount: 10_000,
        lastDeliveredCount: -1,
        lastFiredCount: Number.POSITIVE_INFINITY,
        lastErrorCount: 2
      }
    });
    expect(html).toContain(copy);
    expect(html).toContain("Fireable: 9999 · delivered: 0 · fired: 0 · errors: 2");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.patternRuntime.timeUnavailable"]);
    expect(html).not.toContain("Invalid Date");
  });

  it("keeps the pattern card distinct and preview-only", () => {
    const html = render({
      ...BASE,
      patternRuntime: {
        lastDecision: "fired",
        lastObservedAtIso: "2026-08-09T00:00:00.000Z",
        lastFireableCount: 1,
        lastDeliveredCount: 0,
        lastFiredCount: 1,
        lastErrorCount: 0
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.patternRuntime.title"]);
    expect(html).toContain("Preview only — this records the pattern daemon");
    expect(html).toContain("this view does not send a message.");
    expect(html).not.toContain("POST");
  });
});
