import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AutonomyView, UpcomingSections, UpcomingTab } from "./Autonomy.js";
import { DICTIONARIES } from "../i18n/strings.js";
import { I18nProvider } from "../i18n/index.js";
import { createApiClient } from "../api/client.js";

import type { ApiClient } from "../api/client.js";
import type { Translate } from "../i18n/index.js";
import type {
  AutomationUpcomingResponse,
  UpcomingDigestRuntimeDecision,
  UpcomingProactiveRuntimeDecision,
  UpcomingReminderRuntimeDecision,
  UpcomingFollowupRuntimeDecision
} from "../api/types.js";

const enT = ((key: keyof typeof DICTIONARIES.en, vars?: Record<string, string | number>) => {
  let out: string = DICTIONARIES.en[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replace(`{${name}}`, String(value));
    }
  }
  return out;
}) as unknown as Translate;

const POPULATED: AutomationUpcomingResponse = {
  budget: { dayCap: 6, dayUsed: 2, hourCap: 2, hourUsed: 1 },
  digest: { enabled: true, hour: 18, nextAtIso: "2099-01-01T18:00:00.000Z" },
  digestRuntime: null,
  deliveryQueueSnapshot: {
    followups: {
      overdue: { count: 1, oldestAgeMs: 24 * 60 * 60_000 },
      scheduled: { count: 2, oldestAgeMs: 2 * 24 * 60 * 60_000 }
    },
    generatedAt: "2099-01-01T18:00:00.000Z",
    pendingDrafts: { count: 3, oldestAgeMs: 60 * 60_000 },
    reminders: {
      overdue: { count: 1, oldestAgeMs: 30 * 60_000 },
      scheduled: { count: 1, oldestAgeMs: 3 * 60 * 60_000 }
    },
    status: "observed"
  },
  proactiveRuntime: null,
  gateway: {
    destination: "12345",
    localOnly: false,
    providerId: "telegram",
    reason: null,
    source: "explicit-config",
    status: "resolved"
  },
  nextReminder: { dueAtIso: "2099-01-01T09:00:00.000Z", id: "rem_1", text: "Call the vet" },
  scheduledJobs: [
    { id: "job_1", label: "Morning brief", nextRunAtIso: "2099-01-01T09:00:00.000Z" },
    { id: "job_2", label: "Evening wrap-up", nextRunAtIso: "2099-01-01T20:00:00.000Z" }
  ]
};

const EMPTY: AutomationUpcomingResponse = {
  budget: null,
  digest: null,
  proactiveRuntime: null,
  gateway: {
    destination: null,
    localOnly: false,
    providerId: null,
    reason: "paired-route-inspection-unavailable",
    source: null,
    status: "unconfigured"
  },
  nextReminder: null,
  scheduledJobs: []
};

function renderSections(data: AutomationUpcomingResponse): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <UpcomingSections data={data} t={enT} locale="en-US" />
    </I18nProvider>
  );
}

const DIGEST_RUNTIME_DECISION_COPY: Readonly<Record<UpcomingDigestRuntimeDecision, string>> = {
  "already-running": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.alreadyRunning"],
  "already-sent-today": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.alreadySentToday"],
  "cancelled-before-claim": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.cancelledBeforeClaim"],
  empty: DICTIONARIES.en["auto.upcoming.digestRuntime.decision.empty"],
  error: DICTIONARIES.en["auto.upcoming.digestRuntime.decision.error"],
  "lock-error": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.lockError"],
  "lock-held": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.lockHeld"],
  "not-due": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.notDue"],
  "preflight-failed": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.preflightFailed"],
  "quiet-hours": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.quietHours"],
  "route-unavailable": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.routeUnavailable"],
  "send-failed": DICTIONARIES.en["auto.upcoming.digestRuntime.decision.sendFailed"],
  sent: DICTIONARIES.en["auto.upcoming.digestRuntime.decision.sent"]
};

const PROACTIVE_RUNTIME_DECISION_COPY: Readonly<Record<UpcomingProactiveRuntimeDecision, string>> = {
  "already-running": DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.alreadyRunning"],
  "quiet-hours": DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.quietHours"],
  "route-unavailable": DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.routeUnavailable"],
  "session-locked": DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.sessionLocked"],
  "lock-held": DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.lockHeld"],
  "lock-error": DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.lockError"],
  "no-imminent": DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.noImminent"],
  suppressed: DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.suppressed"],
  fired: DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.fired"],
  completed: DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.completed"],
  error: DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.error"]
};

const REMINDER_RUNTIME_DECISION_COPY: Readonly<Record<UpcomingReminderRuntimeDecision, string>> = {
  "not-configured": DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.notConfigured"],
  "already-running": DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.alreadyRunning"],
  "quiet-hours": DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.quietHours"],
  "lock-held": DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.lockHeld"],
  "lock-error": DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.lockError"],
  "no-due": DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.noDue"],
  fired: DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.fired"],
  completed: DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.completed"],
  error: DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.error"]
};

const FOLLOWUP_RUNTIME_DECISION_COPY: Readonly<Record<UpcomingFollowupRuntimeDecision, string>> = {
  "not-configured": DICTIONARIES.en["auto.upcoming.followupRuntime.decision.notConfigured"],
  "already-running": DICTIONARIES.en["auto.upcoming.followupRuntime.decision.alreadyRunning"],
  "quiet-hours": DICTIONARIES.en["auto.upcoming.followupRuntime.decision.quietHours"],
  "lock-held": DICTIONARIES.en["auto.upcoming.followupRuntime.decision.lockHeld"],
  "lock-error": DICTIONARIES.en["auto.upcoming.followupRuntime.decision.lockError"],
  "no-due": DICTIONARIES.en["auto.upcoming.followupRuntime.decision.noDue"],
  fired: DICTIONARIES.en["auto.upcoming.followupRuntime.decision.fired"],
  completed: DICTIONARIES.en["auto.upcoming.followupRuntime.decision.completed"],
  error: DICTIONARIES.en["auto.upcoming.followupRuntime.decision.error"]
};

describe("UpcomingSections — digest runtime presentation", () => {
  it("keeps the configured schedule distinct from a null runtime observation", () => {
    const html = renderSections(POPULATED);
    expect(html).toContain("daily at 18:00");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.digestRuntime.noObservation"]);
    expect(html).not.toContain(DICTIONARIES.en["auto.upcoming.digestRuntime.decision.sent"]);
  });

  it("renders a sent observation as localized preview-only status with counts", () => {
    const html = renderSections({
      ...POPULATED,
      digestRuntime: {
        lastDecision: "sent",
        lastErrorCount: 0,
        lastItemCount: 1,
        lastObservedAtIso: "2099-01-01T18:00:00.000Z"
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.digestRuntime.decision.sent"]);
    expect(html).toContain("Observed");
    expect(html).toContain("Items: 1 · errors: 0");
    expect(html).toContain("Preview only — follow-up status is informational");
    expect(html).toContain("this view does not send a message.");
  });

  it.each(Object.entries(DIGEST_RUNTIME_DECISION_COPY))("maps %s to human-readable copy", (decision, copy) => {
    const html = renderSections({
      ...POPULATED,
      digestRuntime: {
        lastDecision: decision as UpcomingDigestRuntimeDecision,
        lastErrorCount: 2,
        lastItemCount: 3,
        lastObservedAtIso: "2099-01-01T18:00:00.000Z"
      }
    });
    expect(html).toContain(copy);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.digestRuntime.previewBadge"]);
  });

  it("falls back safely for a future decision value", () => {
    const html = renderSections({
      ...POPULATED,
      digestRuntime: {
        lastDecision: "future-decision" as UpcomingDigestRuntimeDecision,
        lastErrorCount: 0,
        lastItemCount: 0,
        lastObservedAtIso: "2099-01-01T18:00:00.000Z"
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.digestRuntime.decision.unknown"]);
    expect(html).not.toContain("future-decision");
  });
});

describe("UpcomingSections — delivery queue snapshot presentation", () => {
  it("renders the null snapshot as an explicit unavailable, unhealthy preview", () => {
    const html = renderSections(EMPTY);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.deliveryQueue.unavailable"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.deliveryQueue.status.unverified"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.deliveryQueue.previewOnly"]);
  });

  it("renders every observed bucket with bounded ages and counts", () => {
    const html = renderSections(POPULATED);
    expect(html).toContain("Pending drafts: 3 · oldest 1h");
    expect(html).toContain("Follow-ups · scheduled 2 · oldest 2d · overdue 1 · oldest 1d");
    expect(html).toContain("Reminders · scheduled 1 · oldest 3h · overdue 1 · oldest 30m");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.deliveryQueue.status.observed"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.deliveryQueue.previewOnly"]);
  });

  it("keeps unverified and malformed values safe at the render boundary", () => {
    const html = renderSections({
      ...EMPTY,
      deliveryQueueSnapshot: {
        followups: {
          overdue: { count: Number.POSITIVE_INFINITY, oldestAgeMs: -1 },
          scheduled: { count: -1, oldestAgeMs: Number.NaN }
        },
        generatedAt: "not-a-date",
        pendingDrafts: { count: Number.POSITIVE_INFINITY, oldestAgeMs: Number.POSITIVE_INFINITY },
        reminders: {
          overdue: { count: 0, oldestAgeMs: null },
          scheduled: { count: 0, oldestAgeMs: null }
        },
        status: "unverified"
      }
    });
    expect(html).toContain("Pending drafts: 0 · oldest age unavailable");
    expect(html).toContain("Follow-ups · scheduled 0 · oldest age unavailable · overdue 0 · oldest 0m");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.deliveryQueue.timeUnavailable"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.deliveryQueue.status.unverified"]);
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("NaN");
  });

  it("has distinct Korean copy for the queue card and its statuses", () => {
    const keys = [
      "auto.upcoming.deliveryQueue.title",
      "auto.upcoming.deliveryQueue.status.observed",
      "auto.upcoming.deliveryQueue.status.unverified",
      "auto.upcoming.deliveryQueue.generatedAt",
      "auto.upcoming.deliveryQueue.pending",
      "auto.upcoming.deliveryQueue.followups",
      "auto.upcoming.deliveryQueue.reminders",
      "auto.upcoming.deliveryQueue.bucket",
      "auto.upcoming.deliveryQueue.ageUnavailable",
      "auto.upcoming.deliveryQueue.ageMinutes",
      "auto.upcoming.deliveryQueue.ageHours",
      "auto.upcoming.deliveryQueue.ageDays",
      "auto.upcoming.deliveryQueue.timeUnavailable",
      "auto.upcoming.deliveryQueue.unavailable",
      "auto.upcoming.deliveryQueue.previewOnly"
    ] as const;
    for (const key of keys) {
      expect(DICTIONARIES.ko[key]).toBeTruthy();
      expect(DICTIONARIES.ko[key]).not.toBe(DICTIONARIES.en[key]);
    }
  });
});

describe("UpcomingSections — proactive runtime presentation", () => {
  it("truthfully renders null as no observation since this server started", () => {
    const html = renderSections(POPULATED);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.proactiveRuntime.title"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.proactiveRuntime.noObservation"]);
  });

  it.each(Object.entries(PROACTIVE_RUNTIME_DECISION_COPY))("maps %s to human-readable copy", (decision, copy) => {
    const html = renderSections({
      ...POPULATED,
      proactiveRuntime: {
        lastDecision: decision as UpcomingProactiveRuntimeDecision,
        lastObservedAtIso: "2099-01-01T18:00:00.000Z",
        lastImminentCount: 3,
        lastFiredCount: 1,
        lastSuppressedCount: 1,
        lastErrorCount: 0
      }
    });
    expect(html).toContain(copy);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.proactiveRuntime.previewBadge"]);
  });

  it("falls back safely for an unknown decision and never renders raw runtime fields", () => {
    const html = renderSections({
      ...POPULATED,
      proactiveRuntime: {
        lastDecision: "future-decision" as UpcomingProactiveRuntimeDecision,
        lastObservedAtIso: "not-a-date",
        lastImminentCount: 9_999,
        lastFiredCount: 9_999,
        lastSuppressedCount: 9_999,
        lastErrorCount: 9_999,
        sessionLockedUntilIso: "not-a-date"
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.proactiveRuntime.decision.unknown"]);
    expect(html).toContain("Imminent: 9999 · fired: 9999 · suppressed: 9999 · errors: 9999");
    expect(html).toContain("time unavailable");
    expect(html).not.toContain("future-decision");
    expect(html).not.toContain("raw error");
    expect(html).not.toContain("provider-id");
    expect(html).not.toContain("credential");
  });
});

describe("UpcomingSections — reminder runtime presentation", () => {
  it("truthfully renders null as no observation since this server started", () => {
    const html = renderSections(POPULATED);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.reminderRuntime.title"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.reminderRuntime.noObservation"]);
    expect(html).not.toContain(DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.fired"]);
  });

  it.each(Object.entries(REMINDER_RUNTIME_DECISION_COPY))("maps %s to human-readable copy", (decision, copy) => {
    const html = renderSections({
      ...POPULATED,
      reminderRuntime: {
        lastDecision: decision as UpcomingReminderRuntimeDecision,
        lastObservedAtIso: "2099-01-01T09:00:00.000Z",
        lastDueCount: 2,
        lastDeliveredCount: 1,
        lastFiredCount: 1,
        lastErrorCount: 0
      }
    });
    expect(html).toContain(copy);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.reminderRuntime.previewBadge"]);
  });

  it("uses the unknown and date fallbacks and bounds untrusted counts", () => {
    const html = renderSections({
      ...POPULATED,
      reminderRuntime: {
        lastDecision: "future-decision" as UpcomingReminderRuntimeDecision,
        lastObservedAtIso: "not-a-date",
        lastDueCount: 10_000,
        lastDeliveredCount: -1,
        lastFiredCount: Number.POSITIVE_INFINITY,
        lastErrorCount: 10_000
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.reminderRuntime.decision.unknown"]);
    expect(html).toContain("Due: 9999 · delivered: 0 · fired: 0 · errors: 9999");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.reminderRuntime.timeUnavailable"]);
    expect(html).not.toContain("future-decision");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("reminder text");
    expect(html).not.toContain("provider-id");
    expect(html).not.toContain("credential");
  });

  it("has distinct Korean copy for the runtime card and every decision", () => {
    const keys = [
      "auto.upcoming.reminderRuntime.title",
      "auto.upcoming.reminderRuntime.noObservation",
      "auto.upcoming.reminderRuntime.previewBadge",
      "auto.upcoming.reminderRuntime.previewOnly",
      "auto.upcoming.reminderRuntime.observed",
      "auto.upcoming.reminderRuntime.timeUnavailable",
      "auto.upcoming.reminderRuntime.counts",
      "auto.upcoming.reminderRuntime.decision.notConfigured",
      "auto.upcoming.reminderRuntime.decision.alreadyRunning",
      "auto.upcoming.reminderRuntime.decision.quietHours",
      "auto.upcoming.reminderRuntime.decision.lockHeld",
      "auto.upcoming.reminderRuntime.decision.lockError",
      "auto.upcoming.reminderRuntime.decision.noDue",
      "auto.upcoming.reminderRuntime.decision.fired",
      "auto.upcoming.reminderRuntime.decision.completed",
      "auto.upcoming.reminderRuntime.decision.error",
      "auto.upcoming.reminderRuntime.decision.unknown"
    ] as const;
    for (const key of keys) {
      expect(DICTIONARIES.ko[key]).toBeTruthy();
      expect(DICTIONARIES.ko[key]).not.toBe(DICTIONARIES.en[key]);
    }
  });
});

describe("UpcomingSections — follow-up runtime presentation", () => {
  it("truthfully renders null as unhealthy, not configured, and preview-only", () => {
    const html = renderSections(POPULATED);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.followupRuntime.title"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.followupRuntime.noObservation"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.followupRuntime.decision.notConfigured"]);
    expect(html).toContain("Preview only — follow-up status is informational");
  });

  it.each(Object.entries(FOLLOWUP_RUNTIME_DECISION_COPY))("maps %s to human-readable copy", (decision, copy) => {
    const html = renderSections({
      ...POPULATED,
      followupRuntime: {
        lastDecision: decision as UpcomingFollowupRuntimeDecision,
        lastObservedAtIso: "2099-01-01T09:00:00.000Z",
        lastDueCount: 2,
        lastDeliveredCount: 1,
        lastFiredCount: 1,
        lastErrorCount: 0
      }
    });
    expect(html).toContain(copy);
    if (decision !== "not-configured") {
      expect(html).toContain(DICTIONARIES.en["auto.upcoming.followupRuntime.previewBadge"]);
    }
  });

  it("uses unknown and date fallbacks and bounds untrusted counts", () => {
    const html = renderSections({
      ...POPULATED,
      followupRuntime: {
        lastDecision: "future-decision" as UpcomingFollowupRuntimeDecision,
        lastObservedAtIso: "not-a-date",
        lastDueCount: 10_000,
        lastDeliveredCount: -1,
        lastFiredCount: Number.POSITIVE_INFINITY,
        lastErrorCount: 10_000
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.followupRuntime.decision.unknown"]);
    expect(html).toContain("Due: 9999 · delivered: 0 · fired: 0 · errors: 9999");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.followupRuntime.timeUnavailable"]);
    expect(html).not.toContain("future-decision");
    expect(html).not.toContain("Invalid Date");
    expect(html).not.toContain("follow-up summary");
    expect(html).not.toContain("provider-id");
    expect(html).not.toContain("credential");
  });

  it("has distinct Korean copy for the card and every decision", () => {
    const keys = [
      "auto.upcoming.followupRuntime.title",
      "auto.upcoming.followupRuntime.noObservation",
      "auto.upcoming.followupRuntime.previewBadge",
      "auto.upcoming.followupRuntime.previewOnly",
      "auto.upcoming.followupRuntime.observed",
      "auto.upcoming.followupRuntime.timeUnavailable",
      "auto.upcoming.followupRuntime.counts",
      "auto.upcoming.followupRuntime.decision.notConfigured",
      "auto.upcoming.followupRuntime.decision.alreadyRunning",
      "auto.upcoming.followupRuntime.decision.quietHours",
      "auto.upcoming.followupRuntime.decision.lockHeld",
      "auto.upcoming.followupRuntime.decision.lockError",
      "auto.upcoming.followupRuntime.decision.noDue",
      "auto.upcoming.followupRuntime.decision.fired",
      "auto.upcoming.followupRuntime.decision.completed",
      "auto.upcoming.followupRuntime.decision.error",
      "auto.upcoming.followupRuntime.decision.unknown"
    ] as const;
    for (const key of keys) {
      expect(DICTIONARIES.ko[key]).toBeTruthy();
      expect(DICTIONARIES.ko[key]).not.toBe(DICTIONARIES.en[key]);
    }
  });
});

describe("UpcomingSections — populated render", () => {
  it("renders all four sections with the correct counts/numbers", () => {
    const html = renderSections(POPULATED);
    // digest: hour + off-badge absence (enabled)
    expect(html).toContain("daily at 18:00");
    expect(html).not.toContain(DICTIONARIES.en["auto.upcoming.digestOff"]);
    // budget: hourLeft = 2-1=1, dayLeft = 6-2=4
    expect(html).toContain("1/2 left this hour");
    expect(html).toContain("4/6 left today");
    // scheduled jobs: both labels present, count badge = 2
    expect(html).toContain("Morning brief");
    expect(html).toContain("Evening wrap-up");
    expect(html).toContain(">2<");
    // reminder
    expect(html).toContain("Call the vet");
    expect(html).toContain("telegram:12345");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.gatewayNoSend"]);
  });

  it("shows the off badge when digest.enabled is false", () => {
    const html = renderSections({ ...POPULATED, digest: { ...POPULATED.digest!, enabled: false } });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.digestOff"]);
  });

  it("hides a section whose data is null/empty while still rendering the others", () => {
    const html = renderSections({ ...POPULATED, nextReminder: null, scheduledJobs: [] });
    expect(html).not.toContain("Call the vet");
    expect(html).not.toContain("Morning brief");
    expect(html).toContain("daily at 18:00");
    expect(html).toContain("1/2 left this hour");
  });

  it("shows an ambiguity reason instead of selecting one paired route", () => {
    const html = renderSections({
      ...EMPTY,
      gateway: {
        ...EMPTY.gateway,
        reason: "multiple-paired-routes",
        status: "ambiguous"
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.gateway.reason.multiplePairedRoutes"]);
    expect(html).not.toContain("telegram:");
  });
});

describe("UpcomingSections — Gateway held state", () => {
  it("keeps the friendly guidance copy and exposes the inspection reason", () => {
    const html = renderSections(EMPTY);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.emptyTitle"]);
    expect(html).toContain("muse digest");
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.gateway.reason.inspectionUnavailable"]);
  });

  it("KO empty-state guidance is present and distinct from EN", () => {
    expect(DICTIONARIES.ko["auto.upcoming.emptyTitle"]).toBeTruthy();
    expect(DICTIONARIES.ko["auto.upcoming.emptyTitle"]).not.toBe(DICTIONARIES.en["auto.upcoming.emptyTitle"]);
    expect(DICTIONARIES.ko["auto.upcoming.emptyHint"]).toContain("muse digest");
  });
});

describe("UpcomingSections — channel runtime preview", () => {
  it("renders null and all runtime statuses without creating an action", () => {
    const emptyHtml = renderSections(EMPTY);
    expect(emptyHtml).toContain(DICTIONARIES.en["auto.upcoming.channelRuntime.title"]);
    expect(emptyHtml).toContain(DICTIONARIES.en["auto.upcoming.channelRuntime.status.unconfigured"]);
    expect(emptyHtml).toContain(DICTIONARIES.en["auto.upcoming.channelRuntime.noObservation"]);

    for (const status of ["observed", "degraded", "unconfigured"] as const) {
      const html = renderSections({
        ...EMPTY,
        channelRuntime: {
          daemons: [],
          status
        }
      });
      expect(html).toContain(DICTIONARIES.en[`auto.upcoming.channelRuntime.status.${status}`]);
    }
  });

  it("renders malformed dates and counts as safe unavailable values", () => {
    const html = renderSections({
      ...EMPTY,
      channelRuntime: {
        daemons: [{
          hasError: true,
          kind: "slack-poll",
          lastErrorAtIso: "not-a-date",
          lastIngestAtIso: "not-a-date",
          lastIngestCount: Number.POSITIVE_INFINITY,
          running: true
        }],
        status: "degraded"
      }
    });
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.channelRuntime.countUnavailable"]);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.channelRuntime.timeUnavailable"]);
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("not-a-date");
  });

  it("keeps Korean channel-runtime copy distinct from English", () => {
    expect(DICTIONARIES.ko["auto.upcoming.channelRuntime.title"]).toBeTruthy();
    expect(DICTIONARIES.ko["auto.upcoming.channelRuntime.title"]).not.toBe(
      DICTIONARIES.en["auto.upcoming.channelRuntime.title"]
    );
    expect(DICTIONARIES.ko["auto.upcoming.channelRuntime.previewOnly"]).toContain("폴링");
  });
});

describe("AutonomyView — action log is the first and default tab", () => {
  it("renders the action-log tab as selected on first paint (upcoming promoted to its own nav item)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = createApiClient("http://127.0.0.1:3030", "");
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <AutonomyView client={client} />
        </I18nProvider>
      </QueryClientProvider>
    );
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]*?Action log/);
    // Upcoming was promoted to its own nav item — it must NOT render here.
    expect(html).not.toContain(">Upcoming<");
  });
});

describe("AutonomyView — tab order after the Flows and Scheduled promotions", () => {
  it("renders the tab order: Action log, Objectives, Avoidances", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = createApiClient("http://127.0.0.1:3030", "");
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <AutonomyView client={client} />
        </I18nProvider>
      </QueryClientProvider>
    );
    const order = [">Action log<", ">Objectives<", ">Avoidances<"].map((needle) =>
      html.indexOf(needle)
    );
    for (const index of order) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("AutonomyView — connected to an injected fetch fake, no real network", () => {
  it("fetches /api/automation/upcoming through the client (never a bare global fetch)", async () => {
    const getSpy = vi.fn(async (path: string) => {
      expect(path).toBe("/api/automation/upcoming");
      return EMPTY;
    });
    const fakeClient: ApiClient = {
      baseUrl: "http://fake.invalid",
      del: vi.fn(),
      get: getSpy as ApiClient["get"],
      patch: vi.fn(),
      post: vi.fn(),
      put: vi.fn()
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <UpcomingTab client={fakeClient} />
        </I18nProvider>
      </QueryClientProvider>
    );
    await qc.getQueryCache().find({ queryKey: ["automation-upcoming", fakeClient.baseUrl] })?.fetch();
    expect(getSpy).toHaveBeenCalledWith("/api/automation/upcoming");
  });
});
