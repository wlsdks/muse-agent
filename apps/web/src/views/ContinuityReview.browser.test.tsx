import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { I18nProvider } from "../i18n/index.js";
import { OpenedPackCard, type OpenedPack } from "./ContinuityReview.js";

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
