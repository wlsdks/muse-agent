import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import { I18nProvider } from "../i18n/index.js";
import {
  ContinuityReviewView,
  InteractionEvidenceCard,
  OpenedPackCard,
  PendingReviewCard,
  RecentDeliveryCard,
  type InteractionReport,
  type OpenedPack
} from "./ContinuityReview.js";
import { writePersonalStatusFocus } from "./personal-status-navigation.js";

test("personal-status feedback intent is consumed once after the destination review loads", async () => {
  window.localStorage.setItem("muse.lang", "en");
  writePersonalStatusFocus("continuity", "continuity-feedback-review");
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions"
    ? interactionReport({ includeDelivery: false })
    : reminderLinkReview(false));
  const client = { baseUrl: "http://continuity-focus.test", get, post: vi.fn() } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(<QueryClientProvider client={queryClient}><I18nProvider><ContinuityReviewView client={client} /></I18nProvider></QueryClientProvider>);

  await expect.poll(() => document.activeElement?.id).toBe("continuity-feedback-review");
  expect(window.sessionStorage.getItem("muse.personal-status.focus.v1")).toBeNull();
});

test("recent deliveries cannot bypass the canonical provenance-aware review queue", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const base = {
    evidenceRefs: [],
    id: "delivery_technical",
    openedAt: "2026-07-18T00:00:00.000Z",
    thread: { id: "thread_work", kind: "work" as const, title: "Technical delivery" }
  };
  const screen = await render(<I18nProvider><>
    <RecentDeliveryCard delivery={{ ...base, evidenceClass: "unclassified" }} locale="en-US" />
    <RecentDeliveryCard delivery={{
      ...base,
      evidenceClass: "organic",
      id: "delivery_mixed",
      outcome: { evidenceClass: "controlled", outcome: "used", recordedAt: "2026-07-18T01:00:00.000Z" }
    }} locale="en-US" />
  </></I18nProvider>);

  await expect.element(screen.getByText(/unclassified delivery is technical-only/u)).toBeVisible();
  await expect.element(screen.getByText(/existing controlled feedback is technical-only/u)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "used", exact: true })).not.toBeInTheDocument();
});

test("mixed-provenance feedback stays visible but cannot mint organic review evidence", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const onOutcome = vi.fn();
  const screen = await render(<I18nProvider><PendingReviewCard
    disabled={false}
    onOutcome={onOutcome}
    reviewQueue={{
      next: {
        deliveryId: "delivery_mixed",
        evidence: [],
        ineligibleReason: "existing controlled feedback is technical-only and immutable; this delivery cannot receive organic feedback",
        openedAt: "2026-07-18T00:00:00.000Z",
        thread: { id: "thread_work", kind: "work", title: "Mixed evidence" }
      },
      progress: { eligibleDeliveries: 1, remainingFeedback: 1, remainingPacks: 19, reviewedDeliveries: 0, target: 20 }
    }}
  /></I18nProvider>);

  await expect.element(screen.getByText(/existing controlled feedback is technical-only/u)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Record used for delivery_mixed" })).toBeDisabled();
  expect(onOutcome).not.toHaveBeenCalled();
});

function interactionReport(input: {
  readonly exact?: number;
  readonly includeDelivery?: boolean;
  readonly interactionState?: "exact" | "none" | "unavailable";
  readonly status?: "audit-required" | "collecting";
} = {}): InteractionReport {
  const exact = input.exact ?? 0;
  const hasDelivery = input.includeDelivery !== false;
  const interactionState = input.interactionState ?? "none";
  const status = input.status ?? "collecting";
  const lifeCoverage = {
    distinctUtcOpenedDates: exact > 0 ? 1 : 0,
    distinctUtcOpenedDatesTarget: 2,
    exactInteractions: exact,
    exactInteractionsTarget: 10,
    remainingDates: exact > 0 ? 1 : 2,
    remainingExactInteractions: 10 - exact
  };
  const workCoverage = {
    distinctUtcOpenedDates: 0,
    distinctUtcOpenedDatesTarget: 2,
    exactInteractions: 0,
    exactInteractionsTarget: 10,
    remainingDates: 2,
    remainingExactInteractions: 10
  };
  const states = {
    exact: { count: hasDelivery ? exact : 0 },
    none: { count: hasDelivery && exact === 0 ? 1 : 0 },
    unavailable: { count: 0 }
  };
  return {
    audit: { byThreadKind: { life: lifeCoverage, work: workCoverage }, reason: "numeric gap", status },
    digest: {
      byThreadKind: {
        life: { states, totalDeliveries: hasDelivery ? 1 : 0 },
        work: { states: { exact: { count: 0 }, none: { count: 0 }, unavailable: { count: 0 } }, totalDeliveries: 0 }
      },
      overall: { states, totalDeliveries: hasDelivery ? 1 : 0 }
    },
    interactions: input.includeDelivery === false
      ? []
      : [{ deliveryId: "delivery_browser", interaction: { state: interactionState }, threadKind: "life" }],
    schemaVersion: 2,
    technicalEvidence: {
      overall: {
        deliveries: { controlled: 0, organic: hasDelivery ? 1 : 0, unclassified: 0 },
        receipts: { controlled: 0, organic: exact, unclassified: 0 }
      }
    }
  };
}

function opened(nextStep: "direct" | "hidden"): OpenedPack {
  const artifact = {
    artifactId: "task_prepare",
    artifactType: "task",
    providerId: "local",
    role: "next-step",
    summary: "Ask Jamie which flowers they prefer.",
    taskDueAt: "2026-07-16T10:00:00.000Z",
    taskDueState: "overdue" as const,
    taskStatus: "open" as const,
    taskTags: ["birthday", "Jamie"],
    title: "Send flower options"
  };
  return {
    delivery: { id: "delivery_browser" },
    pack: {
      evidence: [{
        artifact,
        reference: {
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          providerId: artifact.providerId,
          role: artifact.role
        },
        status: "available"
      }],
      ...(nextStep === "direct" ? { nextStep: artifact } : {}),
      policy: { nextStep },
      thread: { kind: "life", title: "Prepare birthday" }
    }
  };
}

function reminderLinkReview(linked: boolean) {
  const emptyEvaluation = {
    automationGate: { reasons: ["manual"], status: "hold" as const },
    firstPacks: { considered: 0, rejected: 0, used: 0 },
    improvementGate: { reason: "need natural evidence", status: "awaiting-feedback" },
    outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
    totalDeliveries: 0,
    withOutcome: 0
  };
  return {
    deliveries: [],
    evaluation: {
      ...emptyEvaluation,
      byKind: { life: emptyEvaluation, work: emptyEvaluation },
      longitudinalGate: {
        byKind: {
          life: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 },
          work: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 }
        },
        reasons: ["needs natural feedback"],
        status: "collecting" as const
      },
      technicalEvidence: {
        overall: {
          deliveries: { controlled: 0, organic: 0, unclassified: 0 },
          outcomes: {
            controlled: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
            organic: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
            unclassified: { adjusted: 0, ignored: 0, rejected: 0, used: 0 }
          }
        }
      }
    },
    resetReceipts: [],
    reviewQueue: { progress: { eligibleDeliveries: 0, remainingFeedback: 0, remainingPacks: 20, reviewedDeliveries: 0, target: 20 } },
    threads: [{
      id: "thread_life",
      kind: "life" as const,
      linkCount: linked ? 1 : 0,
      links: linked ? [{ artifactId: "reminder_dentist", artifactType: "reminder", providerId: "local", role: "context" }] : [],
      policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 1 },
      title: "Prepare for dentist"
    }]
  };
}

function calendarLinkReview(linked: boolean) {
  const review = reminderLinkReview(false);
  return {
    ...review,
    calendarProviders: [{ displayName: "Work", id: "work-calendar" }],
    threads: [{
      ...review.threads[0],
      linkCount: linked ? 1 : 0,
      links: linked ? [{ artifactId: "cev1_exact", artifactType: "calendar-event", providerId: "calendar:work-calendar", role: "context" }] : [],
      title: "Review roadmap"
    }]
  };
}

function contactLinkReview(linked: boolean) {
  const review = reminderLinkReview(false);
  return {
    ...review,
    threads: [{
      ...review.threads[0],
      linkCount: linked ? 1 : 0,
      links: linked ? [{ artifactId: "person_김민지_Aa", artifactType: "contact", providerId: "local", role: "context" }] : [],
      title: "Plan a quiet dinner"
    }]
  };
}

const RUN_REFERENCE = "muse-run-v1:ZXhhY3Qtd29ya3NwYWNlLXJ1bi1yZWZlcmVuY2U";
const CHECKPOINT_REFERENCE = "muse-checkpoint-v1:ZXhhY3Qtd29ya3NwYWNlLWNoZWNrcG9pbnQtcmVmZXJlbmNl";

function runLinkReview(linked: boolean) {
  const review = reminderLinkReview(false);
  return {
    ...review,
    threads: [{
      ...review.threads[0],
      linkCount: linked ? 1 : 0,
      links: linked ? [{ artifactId: RUN_REFERENCE, artifactType: "run", providerId: "local", role: "context" }] : [],
      title: "Verify release evidence"
    }]
  };
}

function checkpointLinkReview(linked: boolean) {
  const review = reminderLinkReview(false);
  return {
    ...review,
    threads: [{
      ...review.threads[0],
      linkCount: linked ? 1 : 0,
      links: linked ? [{ artifactId: CHECKPOINT_REFERENCE, artifactType: "checkpoint", providerId: "local", role: "context" }] : [],
      title: "Recover interrupted work"
    }]
  };
}

test("an opened Pack shows its core-derived task status, due state, timestamp, and tags", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={opened("direct")} /></I18nProvider>);

  await expect.element(screen.getByText("Next step: Send flower options", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Open", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Overdue: 2026-07-16T10:00:00.000Z", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Tags: birthday, Jamie", { exact: true })).toBeVisible();
});

test("an opened Pack shows an exact reminder as context without making it completable", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const reminder = {
    artifactId: "reminder_dentist",
    artifactType: "reminder",
    providerId: "local",
    reminderDueAt: "2026-07-16T09:00:00.000Z",
    reminderDueState: "overdue" as const,
    reminderStatus: "pending" as const,
    role: "context",
    title: "Bring the referral letter"
  };
  const reminderPack: OpenedPack = {
    delivery: { id: "delivery_reminder" },
    pack: {
      evidence: [{ artifact: reminder, reference: reminder, status: "available" }],
      policy: { nextStep: "direct" },
      thread: { kind: "life", title: "Prepare for dentist" }
    }
  };
  const onComplete = vi.fn();
  const screen = await render(<I18nProvider><OpenedPackCard
    currentInteractionState="none"
    onComplete={onComplete}
    openedPack={reminderPack}
  /></I18nProvider>);

  await expect.element(screen.getByText("Bring the referral letter · reminder:reminder_dentist", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("pending reminder", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Overdue: 2026-07-16T09:00:00.000Z", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
  expect(onComplete).not.toHaveBeenCalled();
});

test("an opened Pack shows bounded calendar timing and location as read-only context", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const calendar = {
    artifactId: "cev1_exact",
    artifactType: "calendar-event",
    calendarEndsAt: "2026-07-20T10:00:00.000Z",
    calendarLocation: "Room 4",
    calendarStartsAt: "2026-07-20T09:00:00.000Z",
    calendarTimeState: "upcoming" as const,
    providerId: "calendar:work-calendar",
    role: "context",
    title: "Review roadmap"
  };
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={{
    delivery: { id: "delivery_calendar" },
    pack: {
      evidence: [{ artifact: calendar, reference: calendar, status: "available" }],
      policy: { nextStep: "direct" },
      thread: { kind: "work", title: "Roadmap" }
    }
  }} /></I18nProvider>);

  await expect.element(screen.getByText("Review roadmap · calendar-event:cev1_exact", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2026-07-20T09:00:00.000Z", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("upcoming", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Room 4", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
});

test("an opened Pack shows only the safe contact projection as read-only context", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const contact = {
    artifactId: "person_김민지_Aa",
    artifactType: "contact",
    contactBirthday: "03-14",
    contactRelationship: "close friend",
    providerId: "local",
    role: "context",
    summary: "Prefers a quiet dinner",
    title: "Kim Minji"
  };
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={{
    delivery: { id: "delivery_contact" },
    pack: {
      evidence: [{ artifact: contact, reference: contact, status: "available" }],
      policy: { nextStep: "direct" },
      thread: { kind: "life", title: "Plan a quiet dinner" }
    }
  }} /></I18nProvider>);

  await expect.element(screen.getByText("Kim Minji · contact:person_김민지_Aa", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Prefers a quiet dinner", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("close friend", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("03-14", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
  await expect.element(screen.getByText(/must-not-appear@example\.com/u)).not.toBeInTheDocument();
});

test("an opened Pack shows only bounded run evidence as read-only context", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const run = {
    artifactId: RUN_REFERENCE,
    artifactType: "run",
    providerId: "local",
    role: "context",
    runOutcome: "grounded" as const,
    runRecordedAt: "2026-07-22T00:00:00.000Z",
    runSuccess: true,
    runToolNames: ["task_read", "shell"],
    summary: "The focused release gate passed.",
    title: "Verify the release gate"
  };
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={{
    delivery: { id: "delivery_run" },
    pack: {
      evidence: [{ artifact: run, reference: run, status: "available" }],
      policy: { nextStep: "direct" },
      thread: { kind: "work", title: "Release" }
    }
  }} /></I18nProvider>);

  await expect.element(screen.getByText(`Verify the release gate · run:${RUN_REFERENCE}`, { exact: true })).toBeVisible();
  await expect.element(screen.getByText("The focused release gate passed.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Run outcome: grounded", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Run succeeded", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Tools: task_read, shell", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
  await expect.element(screen.getByText(/must-not-appear|127\.0\.0\.1/u)).not.toBeInTheDocument();
});

test("an opened Pack does not mislabel an unknown run success state as failure", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const run = {
    artifactId: RUN_REFERENCE,
    artifactType: "run",
    providerId: "local",
    role: "context",
    runSuccess: null,
    title: "Legacy success state"
  };
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={{
    delivery: { id: "delivery_run_unknown" },
    pack: {
      evidence: [{ artifact: run, reference: run, status: "available" }],
      policy: { nextStep: "direct" },
      thread: { kind: "work", title: "Release" }
    }
  }} /></I18nProvider>);

  await expect.element(screen.getByText("Run succeeded", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Run failed", { exact: true })).not.toBeInTheDocument();
});

test("an opened Pack shows only safe checkpoint context and no action control", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const checkpoint = {
    artifactId: CHECKPOINT_REFERENCE,
    artifactType: "checkpoint",
    checkpointPhase: "act" as const,
    checkpointRecordedAt: "2026-07-22T00:00:00.000Z",
    checkpointStep: 4,
    providerId: "local",
    role: "context",
    summary: "Execution checkpoint 4:act",
    title: "Continue the release checklist"
  };
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={{
    delivery: { id: "delivery_checkpoint" },
    pack: {
      evidence: [{ artifact: checkpoint, reference: checkpoint, status: "available" }],
      policy: { nextStep: "direct" },
      thread: { kind: "work", title: "Release" }
    }
  }} /></I18nProvider>);
  await expect.element(screen.getByText(`Continue the release checklist · checkpoint:${CHECKPOINT_REFERENCE}`, { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Execution checkpoint 4:act", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("4:act", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2026-07-22T00:00:00.000Z", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
  await expect.element(screen.getByText(/encodedMessages|tool secret|resume/u)).not.toBeInTheDocument();
});

test("a reminder can be explicitly linked and unlinked only as context", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let linked = false;
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions"
    ? interactionReport({ includeDelivery: false })
    : reminderLinkReview(linked));
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === "/api/attunement/threads/thread_life/links") {
      expect(body).toEqual({ artifactId: "reminder_den", artifactType: "reminder", role: "context" });
      linked = true;
      return { artifactId: "reminder_dentist", artifactType: "reminder", providerId: "local", role: "context" };
    }
    if (path === "/api/attunement/threads/thread_life/links/unlink") {
      expect(body).toEqual({ artifactId: "reminder_dentist", artifactType: "reminder" });
      linked = false;
      return {};
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const client = { baseUrl: "http://continuity-reminder.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Prepare for dentist", { exact: true })).toBeVisible();
  await screen.getByLabelText("Source type").selectOptions("reminder");
  await expect.element(screen.getByLabelText("How Muse may use it")).toHaveValue("context");
  await expect.element(screen.getByLabelText("How Muse may use it").getByRole("option", { name: "next-step" })).not.toBeInTheDocument();
  await screen.getByLabelText("Exact task/reminder/contact ID, note path, run or checkpoint reference").fill("reminder_den");
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove reminder:reminder_dentist" })).toBeVisible();

  await screen.getByRole("button", { name: "Remove reminder:reminder_dentist" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove reminder:reminder_dentist" })).not.toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(2);
});

test("a contact requires a pasted exact id and can be linked only as context", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let linked = false;
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions"
    ? interactionReport({ includeDelivery: false })
    : contactLinkReview(linked));
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === "/api/attunement/threads/thread_life/links") {
      if ((body as { artifactId?: string }).artifactId === " person_김민지_Aa ") throw new Error("non-canonical contact id");
      expect(body).toEqual({ artifactId: "person_김민지_Aa", artifactType: "contact", role: "context" });
      linked = true;
      return {};
    }
    if (path === "/api/attunement/threads/thread_life/links/unlink") {
      expect(body).toEqual({ artifactId: "person_김민지_Aa", artifactType: "contact" });
      linked = false;
      return {};
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const client = { baseUrl: "http://continuity-contact.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Plan a quiet dinner", { exact: true })).toBeVisible();
  await screen.getByLabelText("Source type").selectOptions("contact");
  await expect.element(screen.getByLabelText("How Muse may use it")).toHaveValue("context");
  await expect.element(screen.getByLabelText("How Muse may use it").getByRole("option", { name: "next-step" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("option", { name: "Kim Minji" })).not.toBeInTheDocument();
  await screen.getByLabelText("Exact task/reminder/contact ID, note path, run or checkpoint reference").fill(" person_김민지_Aa ");
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByText(/could not validate/u)).toBeVisible();
  await screen.getByLabelText("Exact task/reminder/contact ID, note path, run or checkpoint reference").fill("person_김민지_Aa");
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove contact:person_김민지_Aa" })).toBeVisible();

  await screen.getByRole("button", { name: "Remove contact:person_김민지_Aa" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove contact:person_김민지_Aa" })).not.toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(3);
});

test("a run requires a pasted exact reference and can be linked only as context", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let linked = false;
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions"
    ? interactionReport({ includeDelivery: false })
    : runLinkReview(linked));
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === "/api/attunement/threads/thread_life/links") {
      if ((body as { artifactId?: string }).artifactId !== RUN_REFERENCE) throw new Error("non-canonical run reference");
      expect(body).toEqual({ artifactId: RUN_REFERENCE, artifactType: "run", role: "context" });
      linked = true;
      return {};
    }
    if (path === "/api/attunement/threads/thread_life/links/unlink") {
      expect(body).toEqual({ artifactId: RUN_REFERENCE, artifactType: "run" });
      linked = false;
      return {};
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const client = { baseUrl: "http://continuity-run.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Verify release evidence", { exact: true })).toBeVisible();
  await screen.getByLabelText("Source type").selectOptions("run");
  await expect.element(screen.getByLabelText("How Muse may use it")).toHaveValue("context");
  await expect.element(screen.getByLabelText("How Muse may use it").getByRole("option", { name: "next-step" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("option", { name: "Verify the release gate" })).not.toBeInTheDocument();
  const input = screen.getByLabelText("Exact task/reminder/contact ID, note path, run or checkpoint reference");
  await input.fill(` ${RUN_REFERENCE}`);
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByText(/could not validate/u)).toBeVisible();
  await input.fill(RUN_REFERENCE);
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByRole("button", { name: `Remove run:${RUN_REFERENCE}` })).toBeVisible();

  await screen.getByRole("button", { name: `Remove run:${RUN_REFERENCE}` }).click();
  await expect.element(screen.getByRole("button", { name: `Remove run:${RUN_REFERENCE}` })).not.toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(3);
});

test("a checkpoint is paste-only, byte-exact, and context-only", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let linked = false;
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions"
    ? interactionReport({ includeDelivery: false })
    : checkpointLinkReview(linked));
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === "/api/attunement/threads/thread_life/links") {
      if ((body as { artifactId?: string }).artifactId !== CHECKPOINT_REFERENCE) throw new Error("non-canonical checkpoint reference");
      expect(body).toEqual({ artifactId: CHECKPOINT_REFERENCE, artifactType: "checkpoint", role: "context" });
      linked = true;
      return {};
    }
    if (path === "/api/attunement/threads/thread_life/links/unlink") {
      expect(body).toEqual({ artifactId: CHECKPOINT_REFERENCE, artifactType: "checkpoint" });
      linked = false;
      return {};
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const client = { baseUrl: "http://continuity-checkpoint.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={queryClient}><I18nProvider><ContinuityReviewView client={client} /></I18nProvider></QueryClientProvider>);

  await screen.getByLabelText("Source type").selectOptions("checkpoint");
  await expect.element(screen.getByLabelText("How Muse may use it")).toHaveValue("context");
  await expect.element(screen.getByLabelText("How Muse may use it").getByRole("option", { name: "next-step" })).not.toBeInTheDocument();
  const input = screen.getByLabelText("Exact task/reminder/contact ID, note path, run or checkpoint reference");
  await input.fill(` ${CHECKPOINT_REFERENCE}`);
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByText(/could not validate/u)).toBeVisible();
  await input.fill(CHECKPOINT_REFERENCE);
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByRole("button", { name: `Remove checkpoint:${CHECKPOINT_REFERENCE}` })).toBeVisible();
  await screen.getByRole("button", { name: `Remove checkpoint:${CHECKPOINT_REFERENCE}` }).click();
  await expect.element(screen.getByRole("button", { name: `Remove checkpoint:${CHECKPOINT_REFERENCE}` })).not.toBeInTheDocument();
});

test("a calendar occurrence requires an explicit configured provider and can be linked and unlinked", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let linked = false;
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions"
    ? interactionReport({ includeDelivery: false })
    : calendarLinkReview(linked));
  const post = vi.fn(async (path: string, body: unknown) => {
    if (path === "/api/attunement/threads/thread_life/links") {
      expect(body).toEqual({ artifactId: "cev1_exact", artifactType: "calendar-event", providerId: "work-calendar", role: "context" });
      linked = true;
      return {};
    }
    if (path === "/api/attunement/threads/thread_life/links/unlink") {
      expect(body).toEqual({ artifactId: "cev1_exact", artifactType: "calendar-event", providerId: "work-calendar" });
      linked = false;
      return {};
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const client = { baseUrl: "http://continuity-calendar.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Review roadmap", { exact: true })).toBeVisible();
  await screen.getByLabelText("Source type").selectOptions("calendar-event");
  await expect.element(screen.getByRole("button", { name: "Link source" })).toBeDisabled();
  await screen.getByLabelText("Exact task/reminder/contact ID, note path, run or checkpoint reference").fill("cev1_exact");
  await screen.getByLabelText("Calendar provider").selectOptions("work-calendar");
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove calendar-event:cev1_exact" })).toBeVisible();

  await screen.getByRole("button", { name: "Remove calendar-event:cev1_exact" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove calendar-event:cev1_exact" })).not.toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(2);
});

test("a hidden next step exposes only its safe type:id marker", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={opened("hidden")} /></I18nProvider>);

  await expect.element(screen.getByText("task:task_prepare", { exact: true })).toBeVisible();
  for (const hidden of [
    "Send flower options",
    "Ask Jamie which flowers they prefer.",
    "Open",
    "Overdue: 2026-07-16T10:00:00.000Z",
    "Tags: birthday, Jamie"
  ]) {
    await expect.element(screen.getByText(hidden, { exact: true })).not.toBeInTheDocument();
  }
});

test("task completion stays fail-closed outside an available open task with current none interaction", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const done = opened("direct");
  const doneNextStep = { ...done.pack.nextStep!, taskStatus: "done" as const };
  const donePack: OpenedPack = {
    ...done,
    pack: {
      ...done.pack,
      evidence: done.pack.evidence.map((entry) => ({ ...entry, artifact: doneNextStep })),
      nextStep: doneNextStep
    }
  };
  const unavailable = opened("direct");
  const unavailablePack: OpenedPack = {
    ...unavailable,
    pack: {
      ...unavailable.pack,
      evidence: unavailable.pack.evidence.map((entry) => ({ ...entry, artifact: undefined, status: "unavailable" as const }))
    }
  };
  const screen = await render(<I18nProvider><>
    <OpenedPackCard currentInteractionState="exact" onComplete={() => undefined} openedPack={opened("direct")} />
    <OpenedPackCard currentInteractionState="unavailable" onComplete={() => undefined} openedPack={opened("direct")} />
    <OpenedPackCard currentInteractionState="none" onComplete={() => undefined} openedPack={opened("hidden")} />
    <OpenedPackCard currentInteractionState="none" onComplete={() => undefined} openedPack={donePack} />
    <OpenedPackCard currentInteractionState="none" onComplete={() => undefined} openedPack={unavailablePack} />
    <OpenedPackCard onComplete={() => undefined} openedPack={opened("direct")} />
  </></I18nProvider>);

  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
});

test("factual interaction coverage renders separately from outcome evidence", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await render(
    <I18nProvider><InteractionEvidenceCard report={interactionReport()} /></I18nProvider>
  );

  await expect.element(screen.getByText("Factual task interactions", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Collecting", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Life: 0/10 exact · 0/2 opened UTC dates", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Work: 0/10 exact · 0/2 opened UTC dates", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("All deliveries: 0 exact · 1 none · 0 unavailable", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(
    "Numeric interaction coverage does not certify natural timing, usefulness, outcomes, causality, permission, or promotion.",
    { exact: true }
  )).toBeVisible();
  await expect.element(screen.getByText(/All recorded technical evidence — deliveries:/u)).toBeVisible();
});

test("a completed task does not claim a receipt when refreshed interaction coverage stays unchanged", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const current = opened("direct");
  const completedNextStep = { ...current.pack.nextStep!, taskStatus: "done" as const };
  const completed: OpenedPack = {
    ...current,
    pack: {
      ...current.pack,
      evidence: current.pack.evidence.map((entry) => ({ ...entry, artifact: completedNextStep })),
      nextStep: completedNextStep
    }
  };
  const screen = await render(<I18nProvider><>
    <InteractionEvidenceCard report={interactionReport()} />
    <OpenedPackCard
      completionSucceeded
      currentInteractionState="none"
      onComplete={() => undefined}
      openedPack={completed}
    />
  </></I18nProvider>);

  await expect.element(screen.getByText("Task completed. Interaction coverage refreshed.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Life: 0/10 exact · 0/2 opened UTC dates", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
});

test("opening a Pack then completing its canonical current next step refreshes exact coverage without scoring an outcome", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let packOpened = false;
  let taskDone = false;
  let completionAttempts = 0;
  const evaluation = {
    automationGate: { reasons: ["manual"], status: "hold" },
    firstPacks: { considered: 0, rejected: 0, used: 0 },
    improvementGate: { reason: "need natural evidence", status: "awaiting-feedback" },
    outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
    totalDeliveries: packOpened ? 1 : 0,
    withOutcome: 0
  } as const;
  const review = () => ({
    deliveries: packOpened
      ? [{ evidenceClass: "organic", evidenceRefs: [], id: "delivery_browser", openedAt: "2026-07-18T05:00:00.000Z", thread: { id: "thread_life", kind: "life", title: "Prepare birthday" } }]
      : [],
    evaluation: {
      ...evaluation,
      byKind: { life: evaluation, work: { ...evaluation, totalDeliveries: 0 } },
      longitudinalGate: {
        byKind: {
          life: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 },
          work: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 }
        },
        reasons: ["needs natural feedback"],
        status: "collecting"
      },
      technicalEvidence: {
        overall: {
          deliveries: { controlled: 0, organic: packOpened ? 1 : 0, unclassified: 0 },
          outcomes: {
            controlled: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
            organic: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
            unclassified: { adjusted: 0, ignored: 0, rejected: 0, used: 0 }
          }
        }
      }
    },
    resetReceipts: [],
    reviewQueue: { progress: { eligibleDeliveries: 0, remainingFeedback: 0, remainingPacks: 20, reviewedDeliveries: 0, target: 20 } },
    threads: [{
      id: "thread_life",
      kind: "life",
      linkCount: 1,
      links: [{ artifactId: "task_prepare", artifactType: "task", providerId: "local", role: "next-step" }],
      policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 1 },
      title: "Prepare birthday"
    }]
  });
  const get = vi.fn(async (path: string) => {
    if (path === "/api/attunement/interactions") {
      if (!packOpened) return interactionReport({ includeDelivery: false });
      return interactionReport({ exact: taskDone ? 1 : 0, interactionState: taskDone ? "exact" : "none" });
    }
    return review();
  });
  const post = vi.fn(async (path: string) => {
    if (path === "/api/attunement/threads/thread_life/continue") {
      packOpened = true;
      return opened("direct");
    }
    if (path === "/api/tasks/task_prepare/complete") {
      completionAttempts += 1;
      if (completionAttempts === 1) throw new Error("task completion failed");
      taskDone = true;
      return { completedAt: "2026-07-18T05:30:00.000Z", createdAt: "2026-07-18T00:00:00.000Z", id: "task_prepare", status: "done", title: "Send flower options" };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const client = { baseUrl: "http://continuity-loop.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["tasks", client.baseUrl, "open"], { tasks: [], status: "open", total: 0 });
  queryClient.setQueryData(["tasks-count", client.baseUrl], { tasks: [], status: "open", total: 0 });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText(/Production-authorized numeric readiness/u)).toBeVisible();
  await expect.element(screen.getByText("All recorded technical evidence", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Insufficient evidence — no personal-effectiveness percentage is emitted.", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("0%", { exact: true })).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Open pack" }).click();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).toBeVisible();
  await screen.getByRole("button", { name: "Mark next step done" }).click();
  await expect.element(screen.getByText(
    "The task was not completed. The Pack remains open; try again after checking the task.",
    { exact: true }
  )).toBeVisible();
  await expect.element(screen.getByText("Open", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Life: 0/10 exact · 0/2 opened UTC dates", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).toBeVisible();
  await screen.getByRole("button", { name: "Mark next step done" }).click();
  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Life: 1/10 exact · 1/2 opened UTC dates", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Task completed. Interaction coverage refreshed.", { exact: true })).toBeVisible();
  expect(post.mock.calls.some(([path]) => String(path).includes("/outcome"))).toBe(false);
  expect(get.mock.calls.filter(([path]) => path === "/api/attunement/interactions").length).toBeGreaterThanOrEqual(3);
  expect(get.mock.calls.filter(([path]) => path === "/api/attunement/review").length).toBeGreaterThanOrEqual(3);
  expect(queryClient.getQueryState(["tasks", client.baseUrl, "open"])?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(["tasks-count", client.baseUrl])?.isInvalidated).toBe(true);
});

test("a complete organic window renders the API measurement contract instead of recomputing raw rates", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const review = reminderLinkReview(true);
  const metric = (outcome: "used" | "rejected", numerator: number) => ({
    actionId: "review-continuity-feedback" as const,
    claim: "personal-effectiveness" as const,
    evidenceClass: "organic" as const,
    freshness: { asOf: "2026-07-21T10:00:00.000Z", evaluatedAt: "2026-07-22T00:00:00.000Z", staleAfterMs: 2_592_000_000, status: "fresh" as const },
    id: `continuity.first-20.${outcome}.life`,
    schemaVersion: 1 as const,
    source: { id: "attunement-state" as const, version: 8 as const },
    value: { denominator: 20, numerator, unit: "ratio" as const },
    window: { endedAt: "2026-07-21T09:00:00.000Z", startedAt: "2026-07-16T09:00:00.000Z" }
  });
  const life = {
    ...review.evaluation.byKind.life,
    firstPacks: { considered: 3, rejected: 3, used: 0 },
    measurements: [metric("used", 8), metric("rejected", 2)],
    measurementStatus: "available" as const
  };
  const response = { ...review, evaluation: { ...review.evaluation, byKind: { ...review.evaluation.byKind, life } } };
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions" ? interactionReport({ includeDelivery: false }) : response);
  const client = { baseUrl: "http://decision-metric.test", get, post: vi.fn() } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={queryClient}>
    <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
  </QueryClientProvider>);

  await expect.element(screen.getByText("40%", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("10%", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/organic evidence · denominator 20 · attunement-state@8/u)).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Review pending feedback" }).first()).toHaveAttribute("href", "#continuity-feedback-review");
  await expect.element(screen.getByText("100%", { exact: true })).not.toBeInTheDocument();
});

test("Korean Continuity copy labels insufficient evidence and the safe review action", async () => {
  window.localStorage.setItem("muse.lang", "ko");
  const response = reminderLinkReview(true);
  const get = vi.fn(async (path: string) => path === "/api/attunement/interactions" ? interactionReport({ includeDelivery: false }) : response);
  const client = { baseUrl: "http://decision-metric-ko.test", get, post: vi.fn() } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(<QueryClientProvider client={queryClient}>
    <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
  </QueryClientProvider>);

  await expect.element(screen.getByText("근거 부족 — 개인 효과 백분율을 만들지 않습니다.", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "대기 중인 피드백 검토" }).first()).toHaveAttribute("href", "#continuity-feedback-review");
  await expect.element(screen.getByText("0%", { exact: true })).not.toBeInTheDocument();
});

test("an interaction query failure stays scoped and fail-closes task completion without blocking the Pack", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const emptyEvaluation = {
    automationGate: { reasons: ["manual"], status: "hold" },
    firstPacks: { considered: 0, rejected: 0, used: 0 },
    improvementGate: { reason: "need evidence", status: "awaiting-feedback" },
    outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
    totalDeliveries: 0,
    withOutcome: 0
  } as const;
  const review = {
    deliveries: [],
    evaluation: {
      ...emptyEvaluation,
      byKind: { life: emptyEvaluation, work: emptyEvaluation },
      longitudinalGate: {
        byKind: {
          life: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 },
          work: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 }
        },
        reasons: ["needs evidence"],
        status: "collecting"
      },
      technicalEvidence: {
        overall: {
          deliveries: { controlled: 0, organic: 0, unclassified: 0 },
          outcomes: {
            controlled: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
            organic: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
            unclassified: { adjusted: 0, ignored: 0, rejected: 0, used: 0 }
          }
        }
      }
    },
    resetReceipts: [],
    reviewQueue: { progress: { eligibleDeliveries: 0, remainingFeedback: 0, remainingPacks: 20, reviewedDeliveries: 0, target: 20 } },
    threads: [{
      id: "thread_life",
      kind: "life",
      linkCount: 1,
      links: [{ artifactId: "task_prepare", artifactType: "task", providerId: "local", role: "next-step" }],
      policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 1 },
      title: "Prepare birthday"
    }]
  };
  const client = {
    baseUrl: "http://continuity-error.test",
    get: vi.fn(async (path: string) => {
      if (path === "/api/attunement/interactions") throw new Error("interaction unavailable");
      return review;
    }),
    post: vi.fn(async (path: string) => {
      if (path === "/api/attunement/threads/thread_life/continue") return opened("direct");
      throw new Error(`unexpected POST ${path}`);
    })
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Prepare birthday", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Open pack" }).click();
  await expect.element(screen.getByText("Continuity Pack: Prepare birthday", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(
    "Interaction evidence could not be loaded. Continuity review remains available.",
    { exact: true }
  )).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Mark next step done" })).not.toBeInTheDocument();
});

test("explicit feedback advances the shared oldest-pending review to the next delivery", async () => {
  window.localStorage.setItem("muse.lang", "en");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let advanced = false;
  const queue = () => ({
    next: advanced
      ? {
          deliveryId: "delivery_second",
          evidence: [{
            artifact: { artifactId: "task_second", artifactType: "task", providerId: "local", role: "next-step", title: "Second exact task" },
            reference: { artifactId: "task_second", artifactType: "task", providerId: "local", role: "next-step" },
            status: "available"
          }],
          openedAt: "2026-07-17T10:00:00.000Z",
          thread: { id: "thread_work", kind: "work", title: "Second review" }
        }
      : {
          deliveryId: "delivery_first",
          evidence: [{
            artifact: { artifactId: "task_first", artifactType: "task", providerId: "local", role: "next-step", title: "First exact task" },
            reference: { artifactId: "task_first", artifactType: "task", providerId: "local", role: "next-step" },
            status: "available"
          }],
          openedAt: "2026-07-17T09:00:00.000Z",
          thread: { id: "thread_work", kind: "work", title: "First review" }
        },
    progress: { eligibleDeliveries: 2, remainingFeedback: advanced ? 1 : 2, remainingPacks: 18, reviewedDeliveries: advanced ? 1 : 0, target: 20 }
  });
  const evaluation = {
    automationGate: { reasons: ["manual"], status: "hold" },
    firstPacks: { considered: 2, rejected: 0, used: advanced ? 1 : 0 },
    improvementGate: { reason: "need more feedback", status: "awaiting-feedback" },
    outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: advanced ? 1 : 0 },
    totalDeliveries: 2,
    withOutcome: advanced ? 1 : 0
  } as const;
  const response = () => ({
    deliveries: [
      { evidenceClass: "organic", evidenceRefs: [], id: "delivery_second", openedAt: "2026-07-17T10:00:00.000Z", thread: { id: "thread_work", kind: "work", title: "Second review" } },
      { evidenceClass: "organic", evidenceRefs: [], id: "delivery_first", openedAt: "2026-07-17T09:00:00.000Z", ...(advanced ? { outcome: { evidenceClass: "organic", outcome: "used", recordedAt: "2026-07-17T11:00:00.000Z" } } : {}), thread: { id: "thread_work", kind: "work", title: "First review" } }
    ],
    evaluation: {
      ...evaluation,
      byKind: { life: { ...evaluation, totalDeliveries: 0 }, work: evaluation },
      longitudinalGate: {
        byKind: {
          life: { distinctUtcDates: 2, distinctUtcDatesTarget: 2, explicitFeedback: 10, explicitFeedbackTarget: 10, remainingDates: 0, remainingFeedback: 0 },
          work: { distinctUtcDates: 2, distinctUtcDatesTarget: 2, explicitFeedback: 10, explicitFeedbackTarget: 10, remainingDates: 0, remainingFeedback: 0 }
        },
        reasons: ["numeric outcome coverage requires human audit"],
        status: "audit-required"
      },
      technicalEvidence: {
        overall: {
          deliveries: { controlled: 0, organic: 2, unclassified: 0 },
          outcomes: {
            controlled: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
            organic: { adjusted: 0, ignored: 0, rejected: 0, used: advanced ? 1 : 0 },
            unclassified: { adjusted: 0, ignored: 0, rejected: 0, used: 0 }
          }
        }
      }
    },
    resetReceipts: [],
    reviewQueue: queue(),
    threads: []
  });
  const client = {
    baseUrl: "http://continuity.test",
    get: vi.fn(async (path: string) => path === "/api/attunement/interactions" ? interactionReport() : response()),
    post: vi.fn(async (path: string) => {
      if (path === "/api/attunement/deliveries/delivery_first/outcome") advanced = true;
      return {};
    })
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><ContinuityReviewView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Next review: First review", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("First exact task · task:task_first", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Longitudinal evidence", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Human audit required", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Work: 10/10 feedback · 2/2 UTC dates", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Factual task interactions", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Collecting", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Work: 0/10 exact · 0/2 opened UTC dates", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Record used for delivery_first" }).click();
  await expect.element(screen.getByText("Next review: Second review", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Second exact task · task:task_second", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Work: 10/10 feedback · 2/2 UTC dates", { exact: true })).toBeVisible();
});
