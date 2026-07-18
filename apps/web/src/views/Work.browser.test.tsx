import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import "../theme.css";

import { WorkTab } from "./Work.js";
import { consumeBuilderFocusHint } from "./scheduled-logic.js";
import { I18nProvider } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { BoardResponse, FlowsResponse, WorksResponse } from "../api/types.js";

afterEach(() => {
  cleanup();
  window.sessionStorage.removeItem("muse.builderFocusFlow");
});

const WORKS: WorksResponse = {
  works: [
    {
      boardTaskIds: [],
      createdAtIso: "2026-07-18T00:00:00.000Z",
      flowIds: ["job_linked"],
      goal: "파티 준비 끝내기",
      id: "work_1",
      name: "생일 파티 준비",
      outcomes: [],
      status: "active",
      threadId: null,
      updatedAtIso: "2026-07-18T00:00:00.000Z"
    }
  ]
} as unknown as WorksResponse;

const FLOWS: FlowsResponse = {
  flows: [
    {
      edges: [],
      enabled: true,
      id: "job_linked",
      name: "Party reminders",
      nextRunAtIso: "2026-07-19T00:00:00.000Z",
      nodes: [],
      source: "scheduler"
    },
    {
      edges: [],
      enabled: true,
      id: "job_free",
      name: "Free automation",
      nextRunAtIso: null,
      nodes: [],
      source: "scheduler"
    }
  ]
};

const BOARD: BoardResponse = { tasks: [{ id: "task_free", title: "Free task" }] } as unknown as BoardResponse;

function fakeClient(): ApiClient {
  return {
    baseUrl: "http://fake.invalid",
    del: vi.fn(async () => ({})) as unknown as ApiClient["del"],
    get: vi.fn(async (path: string) => {
      if (path === "/api/works") return WORKS;
      if (path === "/api/flows") return FLOWS;
      if (path === "/api/board") return BOARD;
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as ApiClient["get"],
    patch: vi.fn(),
    post: vi.fn(async () => ({})) as unknown as ApiClient["post"],
    put: vi.fn()
  };
}

async function renderWork(client: ApiClient, onNavigate?: (view: string) => void) {
  window.localStorage.setItem("muse.lang", "en");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <WorkTab client={client} onNavigate={onNavigate} />
      </I18nProvider>
    </QueryClientProvider>
  );
  await expect.element(screen.getByText("Party reminders")).toBeVisible();
  return screen;
}

test("picking a flow from the link picker POSTs the link with the PICKED id (no raw-id typing)", async () => {
  const client = fakeClient();
  const screen = await renderWork(client);

  const picker = screen.getByRole("combobox", { name: "Link a flow…" });
  await picker.selectOptions("job_free");

  expect(client.post).toHaveBeenCalledWith("/api/works/work_1/link", { id: "job_free", kind: "flow" });
});

test("Unlink DELETEs the link with the row's id + kind", async () => {
  const client = fakeClient();
  const screen = await renderWork(client);

  await screen.getByRole("button", { name: "Unlink" }).click();

  expect(client.del).toHaveBeenCalledWith("/api/works/work_1/link", { id: "job_linked", kind: "flow" });
});

test("clicking a linked flow's name hands off to the Builder (one-shot focus hint + navigate)", async () => {
  const client = fakeClient();
  const navigate = vi.fn();
  const screen = await renderWork(client, navigate);

  await screen.getByRole("button", { name: "Party reminders" }).click();

  expect(navigate).toHaveBeenCalledWith("flows");
  expect(consumeBuilderFocusHint(window.sessionStorage)).toBe("job_linked");
});
