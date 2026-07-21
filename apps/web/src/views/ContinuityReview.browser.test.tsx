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
  await screen.getByLabelText("Exact task/reminder ID or note path").fill("reminder_den");
  await screen.getByRole("button", { name: "Link source" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove reminder:reminder_dentist" })).toBeVisible();

  await screen.getByRole("button", { name: "Remove reminder:reminder_dentist" }).click();
  await expect.element(screen.getByRole("button", { name: "Remove reminder:reminder_dentist" })).not.toBeInTheDocument();
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
