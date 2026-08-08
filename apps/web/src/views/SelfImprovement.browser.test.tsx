import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "vitest-browser-react";
import { expect, test, vi } from "vitest";

import type { ApiClient } from "../api/client.js";
import type { SelfImprovementStatusResponse } from "../api/types.js";
import { I18nProvider } from "../i18n/index.js";
import { SelfImprovementView } from "./SelfImprovement.js";

function emptyRead(path: string): unknown {
  if (path === "/api/self-improvement/weaknesses") return { entries: [], total: 0 };
  if (path === "/api/self-improvement/playbook") return { entries: [], total: 0 };
  if (path === "/api/self-improvement/reflections") return { entries: [], total: 0 };
  throw new Error(`unexpected GET ${path}`);
}

function clientFor(status: SelfImprovementStatusResponse | Promise<SelfImprovementStatusResponse>): ApiClient {
  const get = vi.fn(async (path: string) => {
    if (path === "/api/self-improvement/status") return await status;
    return emptyRead(path);
  });
  return { baseUrl: "http://self-improvement.test", get } as unknown as ApiClient;
}

async function renderView(client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><SelfImprovementView client={client} /></I18nProvider>
    </QueryClientProvider>
  );
}

test("idle-learning status keeps loading and API-error states local to the card", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let resolveStatus: (status: SelfImprovementStatusResponse) => void = () => undefined;
  const pending = new Promise<SelfImprovementStatusResponse>((resolve) => { resolveStatus = resolve; });
  const loading = await renderView(clientFor(pending));
  await expect.element(loading.getByText("Idle learning status", { exact: true })).toBeVisible();
  await expect.element(loading.getByLabelText("loading")).toBeInTheDocument();
  resolveStatus({
    configured: true,
    enabled: true,
    lastDecision: null,
    lastObservedAtIso: null,
    paused: false,
    pendingCorrections: 0,
    state: "running"
  });
  await cleanup();

  const failed = await renderView(clientFor(Promise.reject(new Error("status unavailable"))));
  await expect.element(failed.getByText("Couldn't load", { exact: true })).toBeVisible();
  await cleanup();
});

test("idle-learning status explains an empty queue without claiming a broken learner", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await renderView(clientFor({
    configured: true,
    enabled: true,
    lastDecision: "completed",
    lastObservedAtIso: "2026-08-08T00:00:00.000Z",
    paused: false,
    pendingCorrections: 0,
    state: "running"
  }));

  await expect.element(screen.getByText("enabled", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("learning not paused", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("0 pending corrections", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Nothing is queued. This alone does not prove learning is broken.", { exact: true })).toBeVisible();
  await cleanup();
});

test("idle-learning status exposes paused and dormant truth", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await renderView(clientFor({
    configured: true,
    enabled: false,
    lastDecision: "disabled",
    lastObservedAtIso: null,
    paused: true,
    pendingCorrections: 2,
    state: "dormant"
  }));

  await expect.element(screen.getByText("disabled", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("learning paused", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("waiting / dormant", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2 pending corrections", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Queued corrections are waiting for the idle safety gates.", { exact: true })).toBeVisible();
  await cleanup();
});

test("idle-learning status refetches and renders the live daemon state", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let current: SelfImprovementStatusResponse = {
    configured: true,
    enabled: false,
    lastDecision: "disabled",
    lastObservedAtIso: null,
    paused: true,
    pendingCorrections: 2,
    state: "dormant"
  };
  const get = vi.fn(async (path: string) => {
    if (path === "/api/self-improvement/status") return current;
    return emptyRead(path);
  });
  const client = { baseUrl: "http://self-improvement-live.test", get } as unknown as ApiClient;
  const screen = await renderView(client);

  await expect.element(screen.getByText("disabled", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("learning paused", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("waiting / dormant", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Last tick: disabled", { exact: true })).toBeVisible();

  current = {
    configured: true,
    enabled: true,
    lastDecision: "waiting-for-idle",
    lastObservedAtIso: "2026-08-08T00:00:10.000Z",
    paused: false,
    pendingCorrections: 0,
    state: "running"
  };
  await expect.poll(
    () => get.mock.calls.filter(([path]) => path === "/api/self-improvement/status").length,
    { interval: 50, timeout: 15_000 }
  ).toBeGreaterThan(1);

  await expect.element(screen.getByText("enabled", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("learning not paused", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("enabled · daemon live", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("0 pending corrections", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Last tick: waiting for user idle time")).toBeVisible();
  await expect.element(screen.getByText("2026-08-08T00:00:10.000Z")).toBeVisible();
  await cleanup();
});
