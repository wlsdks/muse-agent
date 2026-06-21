import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemoryView } from "./Memory.js";
import { NotesView } from "./Notes.js";
import { ToolsView } from "./Tools.js";
import { createApiClient } from "../api/client.js";
import { I18nProvider } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { ComponentType } from "react";

// Render the REAL view component statically. Under renderToStaticMarkup effects
// don't run, so useQuery sits in its initial (loading) state — but the
// search/filter/add inputs render regardless of query state, so their accessible
// names are asserted against PRODUCTION markup (not a mirror copy). A regression
// that strips an aria-label from the real view turns these RED.
function renderView(View: ComponentType<{ client: ApiClient }>): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createApiClient("http://127.0.0.1:3030", "");
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <View client={client} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

describe("console inputs — accessible names against the real views (WCAG 4.1.2)", () => {
  it("ToolsView filter input carries an aria-label (placeholder is not a label)", () => {
    const html = renderView(ToolsView);
    expect(html).toMatch(/<input\b[^>]*\baria-label="Filter tools[^"]*"/);
  });

  it("NotesView search input carries an aria-label", () => {
    const html = renderView(NotesView);
    expect(html).toMatch(/<input\b[^>]*\baria-label="Search across all notes[^"]*"/);
  });

  it("MemoryView userId input carries an aria-label", () => {
    const html = renderView(MemoryView);
    expect(html).toMatch(/<input\b[^>]*\baria-label="User"/);
  });
});
