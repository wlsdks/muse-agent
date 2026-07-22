import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import { I18nProvider } from "../i18n/index.js";
import { AutonomyView } from "./Autonomy.js";
import { writePersonalStatusFocus } from "./personal-status-navigation.js";

test("personal-status veto intent is consumed once by the destination view and focuses the veto panel", async () => {
  window.localStorage.setItem("muse.lang", "en");
  writePersonalStatusFocus("autonomy", "vetoes");
  const get = vi.fn(async (path: string) => {
    if (path === "/api/autonomy/review") return { opportunity: null, schemaVersion: 1 };
    if (path === "/api/vetoes") return { vetoes: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  const client = { baseUrl: "http://veto-focus.test", get, post: vi.fn() } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}><I18nProvider><AutonomyView client={client} /></I18nProvider></QueryClientProvider>
  );

  await expect.element(screen.getByRole("tab", { name: "Avoidances" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => document.activeElement?.id).toBe("vetoes");
  expect(window.sessionStorage.getItem("muse.personal-status.focus.v1")).toBeNull();
});

test("an exact organic opportunity can be reviewed counterfactually and advances to the empty state", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let reviewReads = 0;
  const paths: string[] = [];
  const get = vi.fn(async (path: string) => {
    paths.push(`GET ${path}`);
    if (path === "/api/actions?limit=100") return { actions: [], total: 0 };
    if (path === "/api/autonomy/review") {
      reviewReads += 1;
      return reviewReads === 1
        ? {
            opportunity: {
              action: "muse.tasks.complete-linked-next-step",
              currentSource: { state: "exact" },
              evidenceClass: "organic",
              linkedAt: "2026-07-17T02:00:00.000Z",
              opportunityId: "organic/review 1",
              ownerUserId: "owner",
              recordedAt: "2026-07-17T03:00:00.000Z",
              runId: "run-1",
              shadowAssessment: "wouldConfirm",
              shadowRationale: "no exact active standing grant",
              taskId: "task-next",
              threadId: "thread-life",
              toolCallId: "call-1"
            },
            schemaVersion: 1
          }
        : { opportunity: null, schemaVersion: 1 };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body?: Record<string, unknown>) => {
    paths.push(`POST ${path}`);
    expect(path).toBe("/api/autonomy/opportunities/organic%2Freview%201/decision");
    expect(body).toEqual({ decision: "would-approve", reason: "Fits daily flow" });
    return { review: { decision: "would-approve" }, schemaVersion: 1 };
  });
  const forbidden = vi.fn(async () => {
    throw new Error("unexpected mutating API call");
  });
  const client = {
    baseUrl: "http://autonomy-review.test",
    del: forbidden,
    get,
    patch: forbidden,
    post,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
  });

  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AutonomyView client={client} />
      </I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Shadow review", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("This records a counterfactual judgment only. It does not execute or authorize the action.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("muse.tasks.complete-linked-next-step", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Task task-next · thread thread-life", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("wouldConfirm", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("no exact active standing grant", { exact: true })).toBeVisible();
  await screen.getByRole("radio", { name: "Would approve" }).click();
  await screen.getByLabelText("Reason (optional)").fill("  Fits daily flow  ");
  await screen.getByRole("button", { name: "Record shadow decision" }).click();

  await expect.element(screen.getByText("No organic opportunity is waiting for review.", { exact: true })).toBeVisible();
  expect(post).toHaveBeenCalledTimes(1);
  expect(paths.filter((entry) => entry.startsWith("GET /api/autonomy/review"))).toHaveLength(2);
  expect(paths.some((entry) => /tasks|grants|execute|live|attunement/iu.test(entry))).toBe(false);
  expect(forbidden).not.toHaveBeenCalled();
});

test("reason validation rejects control characters before crossing the HTTP boundary", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const get = vi.fn(async (path: string) => {
    if (path === "/api/actions?limit=100") return { actions: [], total: 0 };
    if (path === "/api/autonomy/review") {
      return {
        opportunity: {
          action: "muse.tasks.complete-linked-next-step",
          currentSource: { state: "exact" },
          evidenceClass: "organic",
          linkedAt: "2026-07-17T02:00:00.000Z",
          opportunityId: "organic-invalid-reason",
          ownerUserId: "owner",
          recordedAt: "2026-07-17T03:00:00.000Z",
          runId: "run-invalid-reason",
          shadowAssessment: "wouldConfirm",
          shadowRationale: "no exact active standing grant",
          taskId: "task-next",
          threadId: "thread-life",
          toolCallId: "call-invalid-reason"
        },
        schemaVersion: 1
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn();
  const forbidden = vi.fn();
  const client = {
    baseUrl: "http://autonomy-validation.test",
    del: forbidden,
    get,
    patch: forbidden,
    post,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><AutonomyView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await screen.getByRole("radio", { name: "Would deny" }).click();
  await screen.getByLabelText("Reason (optional)").fill("line one\nline two");
  await expect.element(screen.getByRole("alert")).toHaveTextContent("remove control characters");
  await expect.element(screen.getByRole("button", { name: "Record shadow decision" })).toBeDisabled();
  await screen.getByLabelText("Reason (optional)").fill(`   ${"a".repeat(500)}   `);
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Record shadow decision" })).toBeEnabled();
  await screen.getByLabelText("Reason (optional)").fill("a".repeat(501));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("at most 500 characters");
  await expect.element(screen.getByRole("button", { name: "Record shadow decision" })).toBeDisabled();
  expect(post).not.toHaveBeenCalled();
  expect(forbidden).not.toHaveBeenCalled();
});

test("a stale source blocks would-approve while preserving the two non-approval judgments", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const get = vi.fn(async (path: string) => {
    if (path === "/api/actions?limit=100") return { actions: [], total: 0 };
    if (path === "/api/autonomy/review") {
      return {
        opportunity: {
          action: "muse.tasks.complete-linked-next-step",
          currentSource: { reason: "recorded task is no longer open", state: "stale" },
          evidenceClass: "organic",
          linkedAt: "2026-07-17T02:00:00.000Z",
          opportunityId: "organic-stale",
          ownerUserId: "owner",
          recordedAt: "2026-07-17T03:00:00.000Z",
          runId: "run-stale",
          shadowAssessment: "wouldConfirm",
          shadowRationale: "no exact active standing grant",
          taskId: "task-stale",
          threadId: "thread-life",
          toolCallId: "call-stale"
        },
        schemaVersion: 1
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const forbidden = vi.fn(async () => {
    throw new Error("unexpected mutating API call");
  });
  const client = {
    baseUrl: "http://autonomy-stale.test",
    del: forbidden,
    get,
    patch: forbidden,
    post: forbidden,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><AutonomyView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Stale", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("recorded task is no longer open", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("radio", { name: "Would approve" })).toBeDisabled();
  await expect.element(screen.getByRole("radio", { name: "Would deny" })).toBeEnabled();
  await expect.element(screen.getByRole("radio", { name: "Needs adjustment" })).toBeEnabled();
  expect(forbidden).not.toHaveBeenCalled();
});

test("an unavailable source locks every decision and cannot POST", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const get = vi.fn(async (path: string) => {
    if (path === "/api/actions?limit=100") return { actions: [], total: 0 };
    if (path === "/api/autonomy/review") {
      return {
        opportunity: {
          action: "muse.tasks.complete-linked-next-step",
          currentSource: { reason: "recorded source stores cannot be read or validated", state: "unavailable" },
          evidenceClass: "organic",
          linkedAt: "2026-07-17T02:00:00.000Z",
          opportunityId: "organic-unavailable",
          ownerUserId: "owner",
          recordedAt: "2026-07-17T03:00:00.000Z",
          runId: "run-unavailable",
          shadowAssessment: "wouldConfirm",
          shadowRationale: "no exact active standing grant",
          taskId: "task-unavailable",
          threadId: "thread-life",
          toolCallId: "call-unavailable"
        },
        schemaVersion: 1
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const forbidden = vi.fn(async () => {
    throw new Error("unexpected mutating API call");
  });
  const client = {
    baseUrl: "http://autonomy-unavailable.test",
    del: forbidden,
    get,
    patch: forbidden,
    post: forbidden,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><AutonomyView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("recorded source stores cannot be read or validated", { exact: true })).toBeVisible();
  for (const name of ["Would approve", "Would deny", "Needs adjustment"]) {
    await expect.element(screen.getByRole("radio", { name })).toBeDisabled();
  }
  await expect.element(screen.getByLabelText("Reason (optional)")).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Record shadow decision" })).toBeDisabled();
  expect(forbidden).not.toHaveBeenCalled();
});

test("a decision conflict retains input, refetches a now-unavailable source, and never retries POST", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let reviewReads = 0;
  let rejectPost: ((reason: Error) => void) | undefined;
  const pendingPost = new Promise<never>((_resolve, reject) => {
    rejectPost = reject;
  });
  const opportunity = (currentSource: Record<string, string>) => ({
    opportunity: {
      action: "muse.tasks.complete-linked-next-step",
      currentSource,
      evidenceClass: "organic",
      linkedAt: "2026-07-17T02:00:00.000Z",
      opportunityId: "organic-conflict",
      ownerUserId: "owner",
      recordedAt: "2026-07-17T03:00:00.000Z",
      runId: "run-conflict",
      shadowAssessment: "wouldConfirm",
      shadowRationale: "no exact active standing grant",
      taskId: "task-conflict",
      threadId: "thread-life",
      toolCallId: "call-conflict"
    },
    schemaVersion: 1
  });
  const get = vi.fn(async (path: string) => {
    if (path === "/api/actions?limit=100") return { actions: [], total: 0 };
    if (path === "/api/autonomy/review") {
      reviewReads += 1;
      return reviewReads === 1
        ? opportunity({ state: "exact" })
        : opportunity({ reason: "recorded source stores cannot be read or validated", state: "unavailable" });
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(() => pendingPost);
  const forbidden = vi.fn(async () => {
    throw new Error("unexpected mutating API call");
  });
  const client = {
    baseUrl: "http://autonomy-conflict.test",
    del: forbidden,
    get,
    patch: forbidden,
    post,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><AutonomyView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await screen.getByRole("radio", { name: "Would approve" }).click();
  const reason = screen.getByLabelText("Reason (optional)");
  await reason.fill("Keep this explanation");
  await screen.getByRole("button", { name: "Record shadow decision" }).click();
  await expect.element(screen.getByRole("button", { name: "Recording…" })).toBeDisabled();
  await expect.element(reason).toBeDisabled();

  rejectPost?.(new Error("409: review conflict"));

  await expect.element(screen.getByRole("alert")).toHaveTextContent("Couldn't record the shadow decision");
  await expect.element(screen.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect.element(reason).toHaveValue("Keep this explanation");
  await expect.element(screen.getByRole("radio", { name: "Would approve" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "Would approve" })).toBeDisabled();
  expect(post).toHaveBeenCalledTimes(1);
  expect(reviewReads).toBe(2);
  expect(forbidden).not.toHaveBeenCalled();
});

test("a failed decision cannot carry its input into a different exact opportunity returned by refetch", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let reviewReads = 0;
  let rejectPost: ((reason: Error) => void) | undefined;
  const pendingPost = new Promise<never>((_resolve, reject) => {
    rejectPost = reject;
  });
  const review = (opportunityId: string, taskId: string) => ({
    opportunity: {
      action: "muse.tasks.complete-linked-next-step",
      currentSource: { state: "exact" },
      evidenceClass: "organic",
      linkedAt: "2026-07-17T02:00:00.000Z",
      opportunityId,
      ownerUserId: "owner",
      recordedAt: "2026-07-17T03:00:00.000Z",
      runId: `run-${opportunityId}`,
      shadowAssessment: "wouldConfirm",
      shadowRationale: "no exact active standing grant",
      taskId,
      threadId: "thread-life",
      toolCallId: `call-${opportunityId}`
    },
    schemaVersion: 1
  });
  const get = vi.fn(async (path: string) => {
    if (path === "/api/actions?limit=100") return { actions: [], total: 0 };
    if (path === "/api/autonomy/review") {
      reviewReads += 1;
      return reviewReads === 1 ? review("opportunity-a", "task-a") : review("opportunity-b", "task-b");
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(() => pendingPost);
  const forbidden = vi.fn(async () => {
    throw new Error("unexpected mutating API call");
  });
  const client = {
    baseUrl: "http://autonomy-new-opportunity.test",
    del: forbidden,
    get,
    patch: forbidden,
    post,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><AutonomyView client={client} /></I18nProvider>
    </QueryClientProvider>
  );

  await screen.getByRole("radio", { name: "Would approve" }).click();
  const reason = screen.getByLabelText("Reason (optional)");
  await reason.fill("Only for opportunity A");
  await screen.getByRole("button", { name: "Record shadow decision" }).click();
  rejectPost?.(new Error("409: review conflict"));

  await expect.element(screen.getByText("Task task-b · thread thread-life", { exact: true })).toBeVisible();
  await expect.element(reason).toHaveValue("");
  await expect.element(screen.getByRole("radio", { name: "Would approve" })).not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Record shadow decision" })).toBeDisabled();
  expect(post).toHaveBeenCalledTimes(1);
  expect(reviewReads).toBe(2);
  expect(forbidden).not.toHaveBeenCalled();
});
