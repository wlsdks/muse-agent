import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FlowsTab } from "./Flows.js";
import { I18nProvider } from "../i18n/index.js";
import { DICTIONARIES } from "../i18n/strings.js";

import type { ApiClient } from "../api/client.js";
import type { FlowsResponse } from "../api/types.js";

const POPULATED: FlowsResponse = {
  flows: [
    {
      edges: [
        { from: "job_1::trigger", id: "job_1::edge-trigger-action", to: "job_1::action" },
        { from: "job_1::action", id: "job_1::edge-action-output", to: "job_1::output" },
        { from: "job_1::action", id: "job_1::edge-retry", label: "실패 시 재시도 ×3", loop: true, to: "job_1::action" }
      ],
      enabled: true,
      id: "job_1",
      name: "Morning brief",
      nextRunAtIso: "2026-07-18T09:00:00.000Z",
      nodes: [
        {
          id: "job_1::trigger",
          kind: "trigger.schedule",
          label: "trigger.schedule",
          meta: { cronExpression: "0 9 * * *", nextRunAtIso: "2026-07-18T09:00:00.000Z", timezone: "UTC" }
        },
        {
          id: "job_1::action",
          kind: "action.agent",
          label: "action.agent",
          meta: { maxToolCalls: null, model: null, prompt: "오늘 일정 요약해서 보내줘" }
        },
        { id: "job_1::output", kind: "output.record", label: "output.record", meta: {} }
      ],
      source: "scheduler"
    },
    {
      edges: [],
      enabled: false,
      id: "job_2",
      name: "Disabled backup",
      nextRunAtIso: null,
      nodes: [],
      source: "scheduler"
    }
  ]
};

const EMPTY: FlowsResponse = { flows: [] };

function fakeClient(response: FlowsResponse): ApiClient {
  return {
    baseUrl: "http://fake.invalid",
    del: vi.fn(),
    get: vi.fn(() => Promise.resolve(response)) as unknown as ApiClient["get"],
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn()
  };
}

async function renderFlowsTab(response: FlowsResponse): Promise<string> {
  const client = fakeClient(response);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await qc.prefetchQuery({ queryFn: () => client.get<FlowsResponse>("/api/flows"), queryKey: ["flows", client.baseUrl] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <FlowsTab client={client} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

// A full interactive React Flow canvas mount (node/edge population fires via
// a client-side effect) needs a real browser — SSR (`renderToStaticMarkup`,
// which is all this Node-environment suite ever uses, no jsdom) renders the
// canvas SHELL without crashing but the `react-flow__nodes` container stays
// empty until mount. So this suite asserts the shell + the list/detail
// panels (which ARE plain SSR-rendered React), not node/edge inner content —
// that's `fable`'s real-browser verification job.
describe("FlowsTab — empty state", () => {
  it("renders the friendly empty-state copy with a real, working `muse scheduler add` example", async () => {
    const html = await renderFlowsTab(EMPTY);
    expect(html).toContain(DICTIONARIES.en["auto.flows.emptyTitle"]);
    expect(html).toContain("muse scheduler add &quot;draft me a morning brief&quot; --every &quot;daily 9am&quot;");
  });

  it("never mounts the canvas shell when there are no flows", async () => {
    const html = await renderFlowsTab(EMPTY);
    expect(html).not.toContain("flow-canvas-wrap");
  });
});

describe("FlowsTab — populated state", () => {
  it("renders the flow list with both flows, enabled dot state, and the canvas shell", async () => {
    const html = await renderFlowsTab(POPULATED);
    expect(html).toContain("Morning brief");
    expect(html).toContain("Disabled backup");
    expect(html).toMatch(/class="dot on"/);
    expect(html).toContain("flow-canvas-wrap");
    expect(html).toContain('class="react-flow');
  });

  it("shows the node-detail empty hint before any node is selected", async () => {
    const html = await renderFlowsTab(POPULATED);
    expect(html).toContain(DICTIONARIES.en["auto.flows.detailEmpty"]);
  });
});

describe("FlowsTab — connected to an injected fetch fake, no real network", () => {
  it("fetches /api/flows through the client", async () => {
    const getSpy = vi.fn(async (path: string) => {
      expect(path).toBe("/api/flows");
      return EMPTY;
    });
    const client: ApiClient = {
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
          <FlowsTab client={client} />
        </I18nProvider>
      </QueryClientProvider>
    );
    await qc.getQueryCache().find({ queryKey: ["flows", client.baseUrl] })?.fetch();
    expect(getSpy).toHaveBeenCalledWith("/api/flows");
  });
});
