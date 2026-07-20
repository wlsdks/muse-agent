import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExecutionsCard } from "./flow-executions.js";
import { I18nProvider } from "../i18n/index.js";
import { DICTIONARIES } from "../i18n/strings.js";

import type { ApiClient } from "../api/client.js";
import type { ScheduledJobExecutionsResponse } from "../api/types.js";

const JOB_ID = "job_1";

const POPULATED: ScheduledJobExecutionsResponse = {
  items: [
    {
      completedAt: 1_752_800_100_000,
      dryRun: false,
      durationMs: 1234,
      failureReason: null,
      id: "exec_1",
      jobId: JOB_ID,
      jobName: "Morning brief",
      payloadPreview: null,
      result: "오늘 일정: 회의 3건, 마감 1건",
      resultPreview: "오늘 일정: 회의 3건, 마감 1건",
      startedAt: 1_752_800_098_766,
      status: "SUCCESS",
      triggeredBy: null
    },
    {
      completedAt: null,
      dryRun: true,
      durationMs: 420,
      failureReason: `Model timeout ${"y".repeat(200)}`,
      id: "exec_2",
      jobId: JOB_ID,
      jobName: "Morning brief",
      payloadPreview: null,
      result: `Job 'Morning brief' failed: ${"x".repeat(200)}`,
      resultPreview: "Job 'Morning brief' failed: xxx…",
      startedAt: 1_752_799_000_000,
      status: "FAILED",
      triggeredBy: null
    }
  ],
  limit: 5,
  offset: 0,
  total: 2
};

const EMPTY: ScheduledJobExecutionsResponse = { items: [], limit: 5, offset: 0, total: 0 };

function fakeClient(response: ScheduledJobExecutionsResponse): ApiClient {
  return {
    baseUrl: "http://fake.invalid",
    del: vi.fn(),
    get: vi.fn(() => Promise.resolve(response)) as unknown as ApiClient["get"],
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn()
  };
}

async function renderExecutions(client: ApiClient): Promise<string> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await qc.prefetchQuery({
    queryFn: () => client.get(`/api/scheduler/jobs/${JOB_ID}/executions?limit=5`),
    queryKey: ["flow-executions", client.baseUrl, JOB_ID]
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ExecutionsCard client={client} jobId={JOB_ID} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

describe("ExecutionsCard — empty state", () => {
  it("shows the friendly empty-state copy", async () => {
    const html = await renderExecutions(fakeClient(EMPTY));
    expect(html).toContain(DICTIONARIES.en["auto.flows.executions.empty"]);
  });
});

describe("ExecutionsCard — populated state", () => {
  it("renders a status tone badge, dry-run badge, and humanized duration for each row", async () => {
    const html = await renderExecutions(fakeClient(POPULATED));
    expect(html).toContain(DICTIONARIES.en["auto.flows.executions.status.success"]);
    expect(html).toContain(DICTIONARIES.en["auto.flows.executions.status.failed"]);
    expect(html).toContain(DICTIONARIES.en["auto.flows.executions.dryRunBadge"]);
    expect(html).toMatch(/class="badge ok"/);
    expect(html).toMatch(/class="badge err"/);
    expect(html).toContain("1.2s");
    expect(html).toContain("0.4s");
  });

  it("clamps a long result preview and offers a 더보기 (show more) toggle only when clamped", async () => {
    const html = await renderExecutions(fakeClient(POPULATED));
    expect(html).toContain(DICTIONARIES.en["auto.flows.executions.showMore"]);
    // the short SUCCESS row's full text renders untruncated, no ellipsis
    expect(html).toContain("오늘 일정: 회의 3건, 마감 1건");
  });

  it("surfaces a FAILED run's clean failureReason in the danger tone, not the raw 'Job … failed:' result", async () => {
    const html = await renderExecutions(fakeClient(POPULATED));
    // The clean reason (failureReason) is what's shown...
    expect(html).toContain("Model timeout");
    expect(html).toContain("exec-error");
    expect(html).toContain("yyy");
    // ...NOT the raw "Job 'Morning brief' failed: xxx…" result body.
    expect(html).not.toContain("xxx");
  });

  it("does not offer a show-more toggle when every result is already short", async () => {
    const shortOnly: ScheduledJobExecutionsResponse = {
      ...POPULATED,
      items: [POPULATED.items[0]!]
    };
    const html = await renderExecutions(fakeClient(shortOnly));
    expect(html).not.toContain(DICTIONARIES.en["auto.flows.executions.showMore"]);
  });

  it("renders the webhook payload preview only when the run was webhook-triggered", async () => {
    const webhookRow: ScheduledJobExecutionsResponse = {
      ...POPULATED,
      items: [
        {
          ...POPULATED.items[0]!,
          id: "exec_webhook",
          payloadPreview: '{"note":"내일 오전 우유 배달 취소"}',
          triggeredBy: "webhook"
        }
      ]
    };
    const html = await renderExecutions(fakeClient(webhookRow));
    expect(html).toContain(DICTIONARIES.en["auto.flows.executions.webhookPayload"]);
    expect(html).toContain("우유 배달 취소");

    // A non-webhook run never shows the payload line, even if a stray preview leaks through.
    const nonWebhook: ScheduledJobExecutionsResponse = {
      ...POPULATED,
      items: [{ ...POPULATED.items[0]!, payloadPreview: "leaked", triggeredBy: null }]
    };
    const plain = await renderExecutions(fakeClient(nonWebhook));
    expect(plain).not.toContain(DICTIONARIES.en["auto.flows.executions.webhookPayload"]);
  });
});

describe("ExecutionsCard — connected to an injected fetch fake, no real network", () => {
  it("fetches the exact GET executions url through the client", async () => {
    const getSpy = vi.fn(async (path: string) => {
      expect(path).toBe(`/api/scheduler/jobs/${JOB_ID}/executions?limit=5`);
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
          <ExecutionsCard client={client} jobId={JOB_ID} />
        </I18nProvider>
      </QueryClientProvider>
    );
    await qc.getQueryCache().find({ queryKey: ["flow-executions", client.baseUrl, JOB_ID] })?.fetch();
    expect(getSpy).toHaveBeenCalledWith(`/api/scheduler/jobs/${JOB_ID}/executions?limit=5`);
  });
});
