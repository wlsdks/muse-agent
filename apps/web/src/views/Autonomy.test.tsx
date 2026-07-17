import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AutonomyView, UpcomingSections } from "./Autonomy.js";
import { DICTIONARIES } from "../i18n/strings.js";
import { I18nProvider } from "../i18n/index.js";
import { createApiClient } from "../api/client.js";

import type { ApiClient } from "../api/client.js";
import type { Translate } from "../i18n/index.js";
import type { AutomationUpcomingResponse } from "../api/types.js";

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
  nextReminder: { dueAtIso: "2099-01-01T09:00:00.000Z", id: "rem_1", text: "Call the vet" },
  scheduledJobs: [
    { id: "job_1", label: "Morning brief", nextRunAtIso: "2099-01-01T09:00:00.000Z" },
    { id: "job_2", label: "Evening wrap-up", nextRunAtIso: "2099-01-01T20:00:00.000Z" }
  ]
};

const EMPTY: AutomationUpcomingResponse = {
  budget: null,
  digest: null,
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
});

describe("UpcomingSections — empty state", () => {
  it("renders the friendly guidance copy when all four sections are absent, never a raw empty page", () => {
    const html = renderSections(EMPTY);
    expect(html).toContain(DICTIONARIES.en["auto.upcoming.emptyTitle"]);
    expect(html).toContain("muse digest");
  });

  it("KO empty-state guidance is present and distinct from EN", () => {
    expect(DICTIONARIES.ko["auto.upcoming.emptyTitle"]).toBeTruthy();
    expect(DICTIONARIES.ko["auto.upcoming.emptyTitle"]).not.toBe(DICTIONARIES.en["auto.upcoming.emptyTitle"]);
    expect(DICTIONARIES.ko["auto.upcoming.emptyHint"]).toContain("muse digest");
  });
});

describe("AutonomyView — upcoming is the first and default tab", () => {
  it("renders the upcoming tab as selected on first paint (no data resolved yet — loading state)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = createApiClient("http://127.0.0.1:3030", "");
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <AutonomyView client={client} />
        </I18nProvider>
      </QueryClientProvider>
    );
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]*?Upcoming/);
    // The FIRST tab button in document order is "Upcoming".
    const firstTabIndex = html.indexOf('role="tab"');
    const upcomingIndex = html.indexOf(">Upcoming<");
    const actionsIndex = html.indexOf(">Action log<");
    expect(firstTabIndex).toBeGreaterThanOrEqual(0);
    expect(upcomingIndex).toBeLessThan(actionsIndex);
  });
});

describe("AutonomyView — tab order after the Flows promotion to its own nav item", () => {
  it("renders the tab order: Upcoming, Action log, Objectives, Avoidances", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const client = createApiClient("http://127.0.0.1:3030", "");
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <AutonomyView client={client} />
        </I18nProvider>
      </QueryClientProvider>
    );
    const order = [">Upcoming<", ">Action log<", ">Objectives<", ">Avoidances<"].map((needle) =>
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
          <AutonomyView client={fakeClient} />
        </I18nProvider>
      </QueryClientProvider>
    );
    await qc.getQueryCache().find({ queryKey: ["automation-upcoming", fakeClient.baseUrl] })?.fetch();
    expect(getSpy).toHaveBeenCalledWith("/api/automation/upcoming");
  });
});
