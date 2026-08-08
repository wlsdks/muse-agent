import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import type { AutomationUpcomingResponse } from "../api/types.js";
import { I18nProvider, useI18n } from "../i18n/index.js";
import { AutonomyView, UpcomingSections, UpcomingTab } from "./Autonomy.js";
import { writePersonalStatusFocus } from "./personal-status-navigation.js";

function UpcomingFixture({ data }: { data: AutomationUpcomingResponse }) {
  const { locale, t } = useI18n();
  return <UpcomingSections data={data} locale={locale} t={t} />;
}

test("route receipts show current Gateway B versus last execution A in EN/KO, safely handle invalid values, and stay GET-only", async () => {
  const data = {
    budget: null,
    digest: { enabled: true, hour: 9, nextAtIso: "2099-01-01T09:00:00.000Z" },
    digestRuntime: {
      lastDecision: "sent" as const,
      lastErrorCount: 0,
      lastItemCount: 1,
      lastObservedAtIso: "2099-01-01T09:00:00.000Z",
      lastRoute: {
        destination: "owner-a",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "paired-owner" as const,
        status: "resolved" as const
      }
    },
    proactiveRuntime: {
      lastDecision: "route-unavailable" as const,
      lastErrorCount: 0,
      lastFiredCount: 0,
      lastImminentCount: 0,
      lastObservedAtIso: "2099-01-01T09:00:00.000Z",
      lastSuppressedCount: 0,
      lastRoute: { status: "not-a-route", rawError: "do not render" } as never
    },
    gateway: {
      destination: "desktop",
      localOnly: true,
      providerId: "log",
      reason: null,
      source: "explicit-config" as const,
      status: "resolved" as const
    },
    nextReminder: null,
    scheduledJobs: []
  } satisfies AutomationUpcomingResponse;
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return data;
  });
  const post = vi.fn();
  const client = { baseUrl: "http://route-receipt.test", get, post } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    window.localStorage.setItem("muse.lang", "en");
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );
    await expect.element(screen.getByText("Current Gateway route", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("log:desktop", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Last execution route: telegram:owner-a · ready", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Last execution route: No route receipt available", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();

    window.localStorage.setItem("muse.lang", "ko");
    const korean = await render(
      <I18nProvider><UpcomingFixture data={data} /></I18nProvider>
    );
    await expect.element(korean.getByText("현재 Gateway 경로", { exact: true })).toBeVisible();
    await expect.element(korean.getByText("마지막 실행 경로: telegram:owner-a · 사용 가능", { exact: true })).toBeVisible();
    await expect.element(korean.getByText("마지막 실행 경로: 경로 영수증 없음", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  } finally {
    queryClient.clear();
  }
});

test("Gateway preview shows the exact route and keeps sending out of the view", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await render(
    <I18nProvider>
      <UpcomingFixture data={{
        budget: null,
        digest: null,
        proactiveRuntime: null,
        gateway: {
          destination: "desktop",
          localOnly: true,
          providerId: "log",
          reason: null,
          source: "explicit-config",
          status: "resolved"
        },
        nextReminder: null,
        scheduledJobs: []
      }} />
    </I18nProvider>
  );

  await expect.element(screen.getByText("log:desktop", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Preview only — no message is sent from this view.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
});

test("Gateway preview shows the source and reason for a held route", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const screen = await render(
    <I18nProvider>
        <UpcomingFixture data={{
          budget: null,
          digest: null,
          proactiveRuntime: null,
          gateway: {
          destination: null,
          localOnly: false,
          providerId: null,
          reason: "multiple-paired-routes",
          source: null,
          status: "ambiguous"
        },
        nextReminder: null,
        scheduledJobs: []
      }} />
    </I18nProvider>
  );

  await expect.element(screen.getByText("No route source is active. · Multiple paired channels exist, so Muse will not guess.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Preview only — no message is sent from this view.", { exact: true })).toBeVisible();
});

test("UpcomingTab refetches live Gateway and digest state while it stays open", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let responseIndex = 0;
  const held: AutomationUpcomingResponse = {
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
  const resolved: AutomationUpcomingResponse = {
    ...held,
    digest: { enabled: true, hour: 9, nextAtIso: "2099-01-01T09:00:00.000Z" },
    gateway: {
      destination: "desktop",
      localOnly: true,
      providerId: "log",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    }
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? held : resolved;
  });
  const client = {
    baseUrl: "http://automation-live.test",
    get,
    post: vi.fn()
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("not configured", { exact: true }).first()).toBeVisible();
    await expect.element(screen.getByText("Preview only — no message is sent from this view.", { exact: true })).toBeVisible();

    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });

    await expect.element(screen.getByText("log:desktop", { exact: true })).toBeVisible();
    await expect.element(screen.getByText(/daily at 9:00/u)).toBeVisible();
    await expect.element(screen.getByText("ready", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Preview only — no message is sent from this view.", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    queryClient.clear();
  }
});

test("UpcomingTab renders channel runtime through GET only and never POSTs", async () => {
  window.localStorage.setItem("muse.lang", "en");
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return {
      budget: null,
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
      },
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
    } satisfies AutomationUpcomingResponse;
  });
  const post = vi.fn();
  const client = {
    baseUrl: "http://channel-runtime.test",
    get,
    post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("Channel runtime", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("degraded", { exact: true }).first()).toBeVisible();
    await expect.element(screen.getByText("Slack poll", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Last ingest: count unavailable · time unavailable", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Operational error observed time unavailable", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  } finally {
    queryClient.clear();
  }
});

test("UpcomingTab refetches digest runtime from no observation to sent without outbound effects", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let responseIndex = 0;
  const before: AutomationUpcomingResponse = {
    budget: null,
    digest: { enabled: true, hour: 9, nextAtIso: "2099-01-01T09:00:00.000Z" },
    digestRuntime: null,
    proactiveRuntime: null,
    gateway: {
      destination: "desktop",
      localOnly: true,
      providerId: "log",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    },
    nextReminder: null,
    scheduledJobs: []
  };
  const after: AutomationUpcomingResponse = {
    ...before,
    digestRuntime: {
      lastDecision: "sent",
      lastErrorCount: 0,
      lastItemCount: 1,
      lastObservedAtIso: "2099-01-01T09:00:00.000Z"
    },
    proactiveRuntime: null
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? before : after;
  });
  const post = vi.fn();
  const client = {
    baseUrl: "http://digest-runtime.test",
    get,
    post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("No digest daemon decision has been observed since this server started.", { exact: true })).toBeVisible();

    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });

    await expect.element(screen.getByText("Digest sent", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Items: 1 · errors: 0", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Preview only — follow-up status is informational; this view does not send a message.", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    queryClient.clear();
  }
});

test("UpcomingTab renders situational briefing runtime in EN/KO through GET only", async () => {
  let responseIndex = 0;
  const before: AutomationUpcomingResponse = {
    budget: null,
    briefingRuntime: null,
    digest: null,
    proactiveRuntime: null,
    gateway: {
      destination: "desktop",
      localOnly: true,
      providerId: "log",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    },
    nextReminder: null,
    scheduledJobs: []
  };
  const after: AutomationUpcomingResponse = {
    ...before,
    briefingRuntime: {
      lastDecision: "delivered",
      lastObservedAtIso: "2099-01-01T09:00:00.000Z",
      lastImminentCount: 3,
      lastDeliveredCount: 2,
      lastErrorCount: 1,
      lastRoute: {
        destination: "briefing-owner",
        localOnly: true,
        providerId: "log",
        reason: null,
        source: "explicit-config",
        status: "resolved"
      }
    }
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? before : after;
  });
  const post = vi.fn();
  const client = {
    baseUrl: "http://briefing-runtime.test",
    get,
    post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    window.localStorage.setItem("muse.lang", "en");
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("Situational briefing runtime", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("No situational briefing daemon decision has been observed since this server started.", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Current Gateway route", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("log:desktop", { exact: true })).toBeVisible();

    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });

    await expect.element(screen.getByText("Briefing delivered", { exact: true })).toBeVisible();
    await expect.element(screen.getByText(/^Observed 1\/1\/2099/u)).toBeVisible();
    await expect.element(screen.getByText("Imminent: 3 · delivered: 2 · errors: 1", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Last execution route: log:briefing-owner · ready", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();

    window.localStorage.setItem("muse.lang", "ko");
    const koreanQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const korean = await render(
        <QueryClientProvider client={koreanQueryClient}>
          <I18nProvider><UpcomingTab client={client} /></I18nProvider>
        </QueryClientProvider>
      );
      await expect.element(korean.getByText("상황 브리핑 런타임", { exact: true })).toBeVisible();
      await expect.element(korean.getByText(/^관찰 시각 2099/u)).toBeVisible();
      await expect.element(korean.getByText("임박: 3 · 전달: 2 · 오류: 1", { exact: true })).toBeVisible();
      await expect.element(korean.getByText("마지막 실행 경로: log:briefing-owner · 사용 가능", { exact: true })).toBeVisible();
      expect(get).toHaveBeenCalledTimes(3);
      expect(post).not.toHaveBeenCalled();
    } finally {
      koreanQueryClient.clear();
    }
  } finally {
    queryClient.clear();
  }
});

test("UpcomingTab refetches proactive runtime from null to fired through the existing GET query without POST", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let responseIndex = 0;
  const before: AutomationUpcomingResponse = {
    budget: null,
    digest: null,
    proactiveRuntime: null,
    gateway: {
      destination: "desktop",
      localOnly: true,
      providerId: "log",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    },
    nextReminder: null,
    scheduledJobs: []
  };
  const after: AutomationUpcomingResponse = {
    ...before,
    proactiveRuntime: {
      lastDecision: "fired",
      lastObservedAtIso: "2099-01-01T09:00:00.000Z",
      lastImminentCount: 1,
      lastFiredCount: 1,
      lastSuppressedCount: 0,
      lastErrorCount: 0
    }
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? before : after;
  });
  const post = vi.fn();
  const client = {
    baseUrl: "http://proactive-runtime.test",
    get,
    post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("No proactive daemon decision has been observed since this server started.", { exact: true })).toBeVisible();
    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });
    await expect.element(screen.getByText("Proactive notice fired", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Imminent: 1 · fired: 1 · suppressed: 0 · errors: 0", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    queryClient.clear();
  }
});

test("UpcomingTab refetches reminder runtime from null to fired through the existing GET query without POST", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let responseIndex = 0;
  const before: AutomationUpcomingResponse = {
    budget: null,
    digest: null,
    proactiveRuntime: null,
    gateway: {
      destination: "desktop",
      localOnly: true,
      providerId: "log",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    },
    nextReminder: null,
    scheduledJobs: []
  };
  const after: AutomationUpcomingResponse = {
    ...before,
    reminderRuntime: {
      lastDecision: "fired",
      lastObservedAtIso: "2099-01-01T09:00:00.000Z",
      lastDueCount: 1,
      lastDeliveredCount: 1,
      lastFiredCount: 1,
      lastErrorCount: 0
    }
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? before : after;
  });
  const post = vi.fn();
  const client = {
    baseUrl: "http://reminder-runtime.test",
    get,
    post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("No reminder daemon decision has been observed since this server started.", { exact: true })).toBeVisible();
    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });
    await expect.element(screen.getByText("Reminder fired", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Due: 1 · delivered: 1 · fired: 1 · errors: 0", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    queryClient.clear();
  }
});

test("UpcomingTab refetches follow-up runtime from null to completed through the existing GET query without POST", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let responseIndex = 0;
  const before: AutomationUpcomingResponse = {
    budget: null,
    digest: null,
    proactiveRuntime: null,
    gateway: {
      destination: "desktop",
      localOnly: true,
      providerId: "log",
      reason: null,
      source: "explicit-config",
      status: "resolved"
    },
    nextReminder: null,
    scheduledJobs: []
  };
  const after: AutomationUpcomingResponse = {
    ...before,
    followupRuntime: {
      lastDecision: "completed",
      lastObservedAtIso: "2099-01-01T09:00:00.000Z",
      lastDueCount: 1,
      lastDeliveredCount: 0,
      lastFiredCount: 0,
      lastErrorCount: 0
    }
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? before : after;
  });
  const post = vi.fn();
  const client = {
    baseUrl: "http://followup-runtime.test",
    get,
    post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("No follow-up daemon decision has been observed since this server started.", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Not configured", { exact: true }).last()).toBeVisible();

    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });
    await expect.element(screen.getByText("Follow-up check completed", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Due: 1 · delivered: 0 · fired: 0 · errors: 0", { exact: true })).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    queryClient.clear();
  }
});

test("UpcomingTab refetches the delivery queue snapshot through GET without POST", async () => {
  window.localStorage.setItem("muse.lang", "en");
  let responseIndex = 0;
  const before: AutomationUpcomingResponse = {
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
  const after: AutomationUpcomingResponse = {
    ...before,
    deliveryQueueSnapshot: {
      followups: {
        overdue: { count: 1, oldestAgeMs: 24 * 60 * 60_000 },
        scheduled: { count: 2, oldestAgeMs: 2 * 24 * 60 * 60_000 }
      },
      generatedAt: "2099-01-01T09:00:00.000Z",
      pendingDrafts: { count: 1, oldestAgeMs: 60 * 60_000 },
      reminders: {
        overdue: { count: 1, oldestAgeMs: 30 * 60_000 },
        scheduled: { count: 1, oldestAgeMs: 3 * 60 * 60_000 }
      },
      status: "observed"
    }
  };
  const get = vi.fn(async (path: string) => {
    expect(path).toBe("/api/automation/upcoming");
    return responseIndex === 0 ? before : after;
  });
  const post = vi.fn();
  const client = {
    baseUrl: "http://delivery-queue.test",
    get,
    post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider><UpcomingTab client={client} /></I18nProvider>
      </QueryClientProvider>
    );

    await expect.element(screen.getByText("Delivery queue snapshot unavailable", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("unverified", { exact: true }).first()).toBeVisible();

    responseIndex = 1;
    await queryClient.refetchQueries({ queryKey: ["automation-upcoming", client.baseUrl] });

    await expect.element(screen.getByText("Pending drafts: 1 · oldest 1h", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Follow-ups · scheduled 2 · oldest 2d · overdue 1 · oldest 1d", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Reminders · scheduled 1 · oldest 3h · overdue 1 · oldest 30m", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("observed", { exact: true }).first()).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    queryClient.clear();
  }
});

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
