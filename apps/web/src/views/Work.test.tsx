import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkTab } from "./Work.js";
import { I18nProvider } from "../i18n/index.js";
import { DICTIONARIES } from "../i18n/strings.js";

import type { ApiClient } from "../api/client.js";
import type { BoardResponse, FlowsResponse, WorksResponse } from "../api/types.js";

const EMPTY_WORKS: WorksResponse = { works: [] };
const EMPTY_FLOWS: FlowsResponse = { flows: [] };
const EMPTY_BOARD: BoardResponse = { tasks: [] };

const POPULATED_WORKS: WorksResponse = {
  works: [
    {
      boardTaskIds: ["board_1"],
      createdAtIso: "2026-07-17T00:00:00.000Z",
      flowIds: ["job_1"],
      goal: "다음 주 토요일까지 준비 끝내기",
      id: "work_1",
      name: "생일 파티 준비",
      outcomes: [{ atIso: "2026-07-17T09:00:00.000Z", kind: "used", note: "helped" }],
      status: "active",
      threadId: "thread_1",
      updatedAtIso: "2026-07-17T09:00:00.000Z"
    },
    {
      boardTaskIds: [],
      createdAtIso: "2026-01-01T00:00:00.000Z",
      flowIds: [],
      goal: "Ship the Q3 deck",
      id: "work_2",
      name: "Q3 deck",
      outcomes: [],
      status: "done",
      updatedAtIso: "2026-01-01T00:00:00.000Z"
    }
  ]
};

const POPULATED_FLOWS: FlowsResponse = {
  flows: [
    { edges: [], enabled: true, id: "job_1", name: "Party reminders", nextRunAtIso: "2026-07-18T09:00:00.000Z", nodes: [], source: "scheduler" },
    // NOT linked to work_1 — must be excluded from the detail's flows section.
    { edges: [], enabled: true, id: "job_unrelated", name: "Unrelated automation", nextRunAtIso: null, nodes: [], source: "scheduler" }
  ]
};

const POPULATED_BOARD: BoardResponse = {
  tasks: [
    { dependsOn: [], id: "board_1", status: "todo", title: "Book the venue" },
    // NOT linked to work_1 — must be excluded from the detail's board-tasks section.
    { dependsOn: [], id: "board_unrelated", status: "todo", title: "Unrelated board task" }
  ]
};

function fakeClient(overrides: Partial<Record<string, unknown>> = {}): ApiClient {
  const responses: Record<string, unknown> = {
    "/api/board": EMPTY_BOARD,
    "/api/flows": EMPTY_FLOWS,
    "/api/works": EMPTY_WORKS,
    ...overrides
  };
  return {
    baseUrl: "http://fake.invalid",
    del: vi.fn(),
    get: vi.fn((path: string) => Promise.resolve(responses[path])) as unknown as ApiClient["get"],
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn()
  };
}

async function renderWorkTab(client: ApiClient): Promise<string> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await qc.prefetchQuery({ queryFn: () => client.get<WorksResponse>("/api/works"), queryKey: ["works", client.baseUrl] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <WorkTab client={client} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

describe("WorkTab — empty state", () => {
  it("renders the friendly empty-state copy with a real, runnable CLI example", async () => {
    const html = await renderWorkTab(fakeClient());
    expect(html).toContain(DICTIONARIES.en["work.emptyTitle"]);
    expect(html).toContain("muse work start");
  });

  it("still offers the create button at zero Work (first-run must not be CLI-only)", async () => {
    const html = await renderWorkTab(fakeClient());
    expect(html).toContain(DICTIONARIES.en["work.create.button"]);
  });
});

describe("WorkTab — populated state", () => {
  it("renders the Work list with name/status/goal for both entries", async () => {
    const html = await renderWorkTab(fakeClient({ "/api/works": POPULATED_WORKS }));
    expect(html).toContain("생일 파티 준비");
    expect(html).toContain("Q3 deck");
    expect(html).toContain(DICTIONARIES.en["work.status.active"]);
  });

  it("shows the detail's three sections + outcome timeline for the first Work, fetching linked flow/board names", async () => {
    const client = fakeClient({ "/api/board": POPULATED_BOARD, "/api/flows": POPULATED_FLOWS, "/api/works": POPULATED_WORKS });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await Promise.all([
      qc.prefetchQuery({ queryFn: () => client.get("/api/works"), queryKey: ["works", client.baseUrl] }),
      qc.prefetchQuery({ queryFn: () => client.get("/api/flows"), queryKey: ["flows", client.baseUrl] }),
      qc.prefetchQuery({ queryFn: () => client.get("/api/board"), queryKey: ["board", client.baseUrl] })
    ]);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <WorkTab client={client} />
        </I18nProvider>
      </QueryClientProvider>
    );
    // The three sections.
    expect(html).toContain(DICTIONARIES.en["work.section.flows"]);
    expect(html).toContain(DICTIONARIES.en["work.section.tasks"]);
    expect(html).toContain(DICTIONARIES.en["work.section.thread"]);
    // Linked flow/task resolved by name/title, not just the raw id — and the
    // UNLINKED flow/task from the same /api/flows and /api/board responses
    // must NOT leak into this Work's sections (this is the filter under test).
    expect(html).toContain("Party reminders");
    expect(html).not.toContain("Unrelated automation");
    expect(html).toContain("Book the venue");
    expect(html).not.toContain("Unrelated board task");
    expect(html).toContain("thread_1");
    // The outcome timeline entry.
    expect(html).toContain("helped");
  });

  it("shows the empty-link hints for a Work with nothing linked yet", async () => {
    const html = await renderWorkTab(fakeClient({ "/api/works": { works: [POPULATED_WORKS.works[1]!] } }));
    expect(html).toContain(DICTIONARIES.en["work.section.flows.empty"]);
    expect(html).toContain(DICTIONARIES.en["work.section.tasks.empty"]);
    expect(html).toContain(DICTIONARIES.en["work.section.thread.empty"]);
    expect(html).toContain(DICTIONARIES.en["work.outcomes.empty"]);
  });
});

describe("WorkTab — i18n parity", () => {
  it("every work.* / nav.work key used by the view exists in KO and is distinct from EN", () => {
    const keys = [
      "nav.work",
      "work.subtitle",
      "work.emptyTitle",
      "work.emptyHint",
      "work.create.button",
      "work.status.active",
      "work.status.paused",
      "work.status.done",
      "work.section.flows",
      "work.section.flows.empty",
      "work.section.tasks",
      "work.section.tasks.empty",
      "work.section.thread",
      "work.section.thread.empty",
      "work.section.thread.linked",
      "work.outcomes",
      "work.outcomes.empty",
      "work.outcome.used",
      "work.outcome.adjusted",
      "work.outcome.ignored"
    ] as const;
    // Product nouns stay English in BOTH locales (owner call, 2026-07-17):
    // the automation surfaces are named Flows/Scheduled/Work everywhere.
    const productNouns = new Set(["nav.work"]);
    for (const key of keys) {
      expect(DICTIONARIES.ko[key], `missing KO string for ${key}`).toBeTruthy();
      if (productNouns.has(key)) {
        expect(DICTIONARIES.ko[key]).toBe(DICTIONARIES.en[key]);
      } else {
        expect(DICTIONARIES.ko[key]).not.toBe(DICTIONARIES.en[key]);
      }
    }
  });
});

describe("WorkTab — connected to an injected fetch fake, no real network", () => {
  it("fetches /api/works through the client", async () => {
    const getSpy = vi.fn(async (path: string) => (path === "/api/works" ? EMPTY_WORKS : EMPTY_FLOWS));
    const client: ApiClient = {
      baseUrl: "http://fake.invalid",
      del: vi.fn(),
      get: getSpy as unknown as ApiClient["get"],
      patch: vi.fn(),
      post: vi.fn(),
      put: vi.fn()
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <WorkTab client={client} />
        </I18nProvider>
      </QueryClientProvider>
    );
    await qc.getQueryCache().find({ queryKey: ["works", client.baseUrl] })?.fetch();
    expect(getSpy).toHaveBeenCalledWith("/api/works");
  });
});
