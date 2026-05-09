import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MuseConsole } from "./App.js";

describe("MuseConsole", () => {
  function renderConsole() {
    const client = new QueryClient({
      defaultOptions: {
        queries: { enabled: false, retry: false }
      }
    });
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MuseConsole />
      </QueryClientProvider>
    );
  }

  it("renders the operator workspace shell without API data", () => {
    const html = renderConsole();
    expect(html).toContain("Muse");
    expect(html).toContain("Ask Muse");
    expect(html).toContain("Tasks");
    expect(html).toContain("Upcoming");
  });

  it("renders the new tool catalog and orchestration panels in the side panel", () => {
    const html = renderConsole();
    expect(html).toContain("Tools");
    expect(html).toContain("Orchestrations");
  });

  it("includes status metrics for tools and orchestrations counts", () => {
    const html = renderConsole();
    // Status strip metric labels — capitalised plural forms.
    expect(html).toMatch(/<span>Tools<\/span>/u);
    expect(html).toMatch(/<span>Orchestrations<\/span>/u);
  });
});

