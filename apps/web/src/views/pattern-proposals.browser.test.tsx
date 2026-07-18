import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import "../theme.css";

import { PatternProposalCards } from "./pattern-proposals.js";
import { I18nProvider } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { AutomationProposalsResponse } from "../api/types.js";

afterEach(cleanup);

const PROPOSALS: AutomationProposalsResponse = {
  proposals: [
    {
      category: "time-of-day-action",
      cronExpression: "0 9 * * 1",
      id: "tod-1",
      receipt: {
        confidence: 0.9,
        distinctCount: 3,
        distinctUnit: "days",
        examples: ["/notes/journal/a.md", "/notes/journal/b.md"],
        observationCount: 3
      },
      suggestionText: "매주 월요일 오전 9시에 저널을 정리하시는군요.",
      title: "월요일 오전 9시 루틴"
    }
  ]
};

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "http://fake.invalid",
    del: vi.fn(async () => undefined) as unknown as ApiClient["del"],
    get: vi.fn(async (path: string) => {
      if (path === "/api/automation/proposals") return PROPOSALS;
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as ApiClient["get"],
    patch: vi.fn(async () => ({})) as unknown as ApiClient["patch"],
    post: vi.fn(async () => ({ ok: true })) as unknown as ApiClient["post"],
    put: vi.fn(async () => ({})) as unknown as ApiClient["put"],
    ...overrides
  };
}

async function renderCards(client: ApiClient, onOpenDraft: (text: string) => void = () => undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <PatternProposalCards client={client} onOpenDraft={onOpenDraft} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

test("renders nothing when the server returns zero proposals — zero noise", async () => {
  const client = fakeClient({
    get: vi.fn(async (path: string) => {
      if (path === "/api/automation/proposals") return { proposals: [] };
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as ApiClient["get"]
  });
  await renderCards(client);
  await expect.poll(() => (client.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  expect(document.querySelector(".pattern-proposal-card")).toBeNull();
});

test("renders a card from the fixture with the exact suggestion text and receipt", async () => {
  const client = fakeClient();
  const screen = await renderCards(client);

  await expect.element(screen.getByText("매주 월요일 오전 9시에 저널을 정리하시는군요.")).toBeVisible();
  await expect.element(screen.getByText("월요일 오전 9시 루틴")).toBeVisible();
  await expect.element(screen.getByText("Observed 3 times across 3 days (confidence 90%).")).toBeVisible();
});

test("근거 보기 (See evidence) expands the examples list, and toggles back to hide it", async () => {
  const client = fakeClient();
  const screen = await renderCards(client);

  expect(document.querySelector(".pattern-proposal-examples")).toBeNull();
  await screen.getByRole("button", { name: "See evidence" }).click();
  await expect.element(screen.getByText("/notes/journal/a.md")).toBeVisible();
  await expect.element(screen.getByText("/notes/journal/b.md")).toBeVisible();

  await screen.getByRole("button", { name: "Hide evidence" }).click();
  await expect.poll(() => document.querySelector(".pattern-proposal-examples")).toBeNull();
});

test("사양할게요 (No thanks) POSTs the exact reject path and the card disappears", async () => {
  // A contract-faithful fake: GET actually reflects what POST /reject did
  // (never a fake registry ignoring the mutation), so the invalidated
  // query's refetch genuinely proves the server-side effect took hold.
  const rejectedIds = new Set<string>();
  const post = vi.fn(async (path: string) => {
    const match = /^\/api\/automation\/proposals\/([^/]+)\/reject$/.exec(path);
    if (match) rejectedIds.add(decodeURIComponent(match[1]!));
    return { ok: true };
  }) as unknown as ApiClient["post"];
  const get = vi.fn(async (path: string) => {
    if (path === "/api/automation/proposals") {
      return { proposals: PROPOSALS.proposals.filter((p) => !rejectedIds.has(p.id)) };
    }
    throw new Error(`unexpected GET ${path}`);
  }) as unknown as ApiClient["get"];
  const client = fakeClient({ get, post });
  await renderCards(client);

  await expect.poll(() => document.querySelector(".pattern-proposal-card")).not.toBeNull();
  document.querySelector<HTMLButtonElement>(".pattern-proposal-actions .btn-ghost")!.click();

  await expect.poll(() => (post as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  expect((post as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["/api/automation/proposals/tod-1/reject"]);
  await expect.poll(() => document.querySelector(".pattern-proposal-card")).toBeNull();
});

test("흐름 초안 열기 (Open flow draft) calls onOpenDraft with the exact suggestionText", async () => {
  const client = fakeClient();
  const onOpenDraft = vi.fn();
  const screen = await renderCards(client, onOpenDraft);

  await screen.getByRole("button", { name: "Open flow draft" }).click();
  expect(onOpenDraft).toHaveBeenCalledWith("매주 월요일 오전 9시에 저널을 정리하시는군요.");
});
