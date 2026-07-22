import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ApiClient } from "../api/client.js";
import { I18nProvider } from "../i18n/index.js";
import { JourneyView } from "./Journey.js";
import { writePersonalStatusFocus } from "./personal-status-navigation.js";

test("personal-status learning intent is consumed once by the destination history", async () => {
  window.localStorage.setItem("muse.lang", "en");
  writePersonalStatusFocus("journey", "learning-history");
  const get = vi.fn(async () => ({ events: [], total: 0 }));
  const client = { baseUrl: "http://journey-focus.test", get } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}><I18nProvider><JourneyView client={client} /></I18nProvider></QueryClientProvider>
  );

  await expect.poll(() => document.activeElement?.id).toBe("learning-history");
  expect(window.sessionStorage.getItem("muse.personal-status.focus.v1")).toBeNull();
});
