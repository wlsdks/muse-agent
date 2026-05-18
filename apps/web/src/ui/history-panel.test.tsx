import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HistoryPanel, buildHistoryQuery, relativeFromNow } from "./history-panel.js";
import type { ApiClient } from "./api-client.js";

const fakeClient = {
  delete: async () => { throw new Error("unused"); },
  get: async () => { throw new Error("unused"); },
  post: async () => { throw new Error("unused"); },
  put: async () => { throw new Error("unused"); }
} as unknown as ApiClient;

function render(seed?: { entries: unknown[]; total: number }): string {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } }
  });
  if (seed) {
    client.setQueryData(["history", "all", 20], seed);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <HistoryPanel client={fakeClient} />
    </QueryClientProvider>
  );
}

describe("relativeFromNow", () => {
  const now = Date.parse("2026-05-18T12:00:00Z");
  const ago = (ms: number): string => new Date(now - ms).toISOString();
  const ahead = (ms: number): string => new Date(now + ms).toISOString();

  it("buckets sub-minute / minute / hour / day deltas", () => {
    expect(relativeFromNow(ago(30_000), now)).toBe("just now");
    expect(relativeFromNow(ago(5 * 60_000), now)).toBe("5m ago");
    expect(relativeFromNow(ago(2 * 3_600_000), now)).toBe("2h ago");
    expect(relativeFromNow(ago(3 * 86_400_000), now)).toBe("3d ago");
  });

  it("prefixes future deltas with 'in'", () => {
    expect(relativeFromNow(ahead(45 * 60_000), now)).toBe("in 45m");
  });

  it("falls back to a locale date beyond 7 days and passes through junk", () => {
    expect(relativeFromNow(ago(10 * 86_400_000), now)).not.toMatch(/ago$/u);
    expect(relativeFromNow("not-a-date", now)).toBe("not-a-date");
  });
});

describe("HistoryPanel", () => {
  it("renders the activity surface heading and aria-label without data", () => {
    const html = render();
    expect(html).toContain("<h2>Activity</h2>");
    expect(html).toContain('aria-label="Activity history"');
    // No entries seeded → empty record list, count falls back to 0.
    expect(html).toContain("<ul class=\"record-list\"></ul>");
  });

  it("renders each activity entry's summary, kind and relative time", () => {
    const html = render({
      entries: [
        { kind: "proactive", summary: "Standup in 5 min", whenIso: new Date(Date.now() - 5 * 60_000).toISOString(), status: "delivered" },
        { kind: "reminder", summary: "Submit memo", whenIso: new Date(Date.now() - 2 * 3_600_000).toISOString() }
      ],
      total: 2
    });
    expect(html).toContain("Standup in 5 min");
    expect(html).toContain("proactive");
    expect(html).toContain("delivered");
    expect(html).toContain("Submit memo");
    expect(html).toContain("reminder");
  });

  it("renders the kind-filter and limit-selector controls with their options", () => {
    const html = render();
    expect(html).toContain('aria-label="Filter by kind"');
    expect(html).toContain('aria-label="Max entries"');
    // "all" is the default-selected kind; React emits selected="".
    expect(html).toContain('<option value="all" selected="">all</option>');
    expect(html).toContain('<option value="proactive">proactive</option>');
    expect(html).toContain('<option value="100">100</option>');
  });
});

describe("buildHistoryQuery", () => {
  it("omits the kind param for 'all' and only sets limit", () => {
    expect(buildHistoryQuery("all", 20)).toBe("/api/history?limit=20");
  });

  it("appends the kind param for a specific activity kind", () => {
    expect(buildHistoryQuery("reminder", 50)).toBe("/api/history?limit=50&kind=reminder");
    expect(buildHistoryQuery("proactive", 100)).toBe("/api/history?limit=100&kind=proactive");
  });
});
