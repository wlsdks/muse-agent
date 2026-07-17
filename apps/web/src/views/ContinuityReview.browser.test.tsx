import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import { I18nProvider } from "../i18n/index.js";
import { ContinuityReviewView, OpenedPackCard, type OpenedPack } from "./ContinuityReview.js";

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

test("an opened Pack shows its core-derived task status, due state, timestamp, and tags", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await render(<I18nProvider><OpenedPackCard openedPack={opened("direct")} /></I18nProvider>);

  await expect.element(screen.getByText("Next step: Send flower options", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Open", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Overdue: 2026-07-16T10:00:00.000Z", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Tags: birthday, Jamie", { exact: true })).toBeVisible();
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
      { evidenceRefs: [], id: "delivery_second", openedAt: "2026-07-17T10:00:00.000Z", thread: { id: "thread_work", kind: "work", title: "Second review" } },
      { evidenceRefs: [], id: "delivery_first", openedAt: "2026-07-17T09:00:00.000Z", ...(advanced ? { outcome: { outcome: "used", recordedAt: "2026-07-17T11:00:00.000Z" } } : {}), thread: { id: "thread_work", kind: "work", title: "First review" } }
    ],
    evaluation: {
      ...evaluation,
      byKind: { life: { ...evaluation, totalDeliveries: 0 }, work: evaluation },
      longitudinalGate: {
        byKind: {
          life: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 },
          work: { distinctUtcDates: advanced ? 1 : 0, distinctUtcDatesTarget: 2, explicitFeedback: advanced ? 1 : 0, explicitFeedbackTarget: 10, remainingDates: advanced ? 1 : 2, remainingFeedback: advanced ? 9 : 10 }
        },
        reasons: ["life needs more explicit feedback", "work needs more explicit feedback"],
        status: "collecting"
      }
    },
    resetReceipts: [],
    reviewQueue: queue(),
    threads: []
  });
  const client = {
    baseUrl: "http://continuity.test",
    get: vi.fn(async () => response()),
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
  await expect.element(screen.getByText("Collecting", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Work: 0/10 feedback · 0/2 UTC dates", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Record used for delivery_first" }).click();
  await expect.element(screen.getByText("Next review: Second review", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Second exact task · task:task_second", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Work: 1/10 feedback · 1/2 UTC dates", { exact: true })).toBeVisible();
});
