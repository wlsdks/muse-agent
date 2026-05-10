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

  it("renders the Voice panel with a Record button by default", () => {
    const html = renderConsole();
    expect(html).toContain("Voice");
    expect(html).toContain("Record");
  });

  it("renders the Notes panel with a save form", () => {
    const html = renderConsole();
    expect(html).toContain("Notes");
    // The save form's filename input + body textarea + Save button —
    // textarea by aria-label, button label.
    expect(html).toContain('placeholder="filename.md"');
    expect(html).toContain('aria-label="New note content"');
    expect(html).toMatch(/>\s*Save\s*<\/button>/u);
  });

  it("renders the Memory panel section heading", () => {
    const html = renderConsole();
    // The memory panel renders the Memory aria-label section + heading
    // even before /api/user-memory/me resolves (queries are disabled
    // in the static test render).
    expect(html).toContain('aria-label="Memory"');
    expect(html).toMatch(/<h2>Memory<\/h2>/u);
  });

  it("includes status metrics for tools and orchestrations counts", () => {
    const html = renderConsole();
    // Status strip metric labels — capitalised plural forms.
    expect(html).toMatch(/<span>Tools<\/span>/u);
    expect(html).toMatch(/<span>Orchestrations<\/span>/u);
  });
});

