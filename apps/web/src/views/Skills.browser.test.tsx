import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import type { SkillsResponse } from "../api/types.js";
import { I18nProvider } from "../i18n/index.js";
import { SkillsView } from "./Skills.js";

const response: SkillsResponse = {
  total: 1,
  entries: [{
    avoided: false,
    description: "Release safely",
    lastActivity: "2026-08-09T00:00:00.000Z",
    name: "release",
    reward: 1,
    source: "authored",
    useCount: 2,
    viewCount: 3
  }]
};

function client(): ApiClient {
  return {
    baseUrl: "http://skills.test",
    get: vi.fn(async () => response),
    post: vi.fn(async () => ({ name: "release", reward: 1 }))
  } as unknown as ApiClient;
}

test("Skills shows durable usage evidence in English and Korean", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.localStorage.setItem("muse.lang", "en");
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><SkillsView client={client()} /></I18nProvider>
    </QueryClientProvider>
  );
  await expect.element(screen.getByText("used 2 · read 3 · last 2026-08-09", { exact: true })).toBeVisible();

  window.localStorage.setItem("muse.lang", "ko");
  const korean = await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider><SkillsView client={client()} /></I18nProvider>
    </QueryClientProvider>
  );
  await expect.element(korean.getByText("적용 2회 · 읽기 3회 · 최근 2026-08-09", { exact: true })).toBeVisible();
});
