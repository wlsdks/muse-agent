import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import type { AutomationUpcomingResponse } from "../api/types.js";
import { I18nProvider } from "../i18n/index.js";
import { UpcomingTab } from "./Autonomy.js";

const base: AutomationUpcomingResponse = {
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

test("pattern runtime transitions through the existing GET refetch without POST", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let responseIndex = 0;
  const after: AutomationUpcomingResponse = {
    ...base,
    patternRuntime: {
      lastDecision: "fired",
      lastObservedAtIso: "2099-01-01T09:00:00.000Z",
      lastFireableCount: 1,
      lastDeliveredCount: 0,
      lastFiredCount: 1,
      lastErrorCount: 0
    }
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? base : after;
  });
  const post = vi.fn();
  const client = { baseUrl: "http://pattern-runtime.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );
    await expect.element(screen.getByText("No pattern daemon decision has been observed since this server started.", { exact: true })).toBeVisible();

    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });

    await expect.element(screen.getByText("Pattern notice fired", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Fireable: 1 · delivered: 0 · fired: 1 · errors: 0", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  } finally {
    queryClient.clear();
  }
});
