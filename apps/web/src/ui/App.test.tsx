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

  it("renders the Scheduler panel section heading", () => {
    const html = renderConsole();
    // The scheduler panel renders before /api/scheduler/jobs resolves
    // (queries are disabled in the static test render). Header `Scheduler`
    // and aria-label both present.
    expect(html).toContain('aria-label="Scheduler"');
    expect(html).toMatch(/<h2>Scheduler<\/h2>/u);
  });

  it("renders the LLM cost panel section heading", () => {
    const html = renderConsole();
    // Token-cost panel: aria-label "LLM cost", header "LLM cost (7d)".
    expect(html).toContain('aria-label="LLM cost"');
    expect(html).toMatch(/<h2>LLM cost \(7d\)<\/h2>/u);
  });

  it("renders the Messaging panel section heading", () => {
    const html = renderConsole();
    expect(html).toContain('aria-label="Messaging"');
    expect(html).toMatch(/<h2>Messaging<\/h2>/u);
  });

  it("renders the Reminders panel with text + when inputs and an Add reminder button", () => {
    const html = renderConsole();
    expect(html).toContain('aria-label="Reminders"');
    expect(html).toMatch(/<h2>Reminders<\/h2>/u);
    // The add form has two inputs: a text body and a "when" parser input.
    expect(html).toContain('placeholder="Reminder text…"');
    expect(html).toMatch(/placeholder="When \(/u);
    expect(html).toMatch(/>\s*Add reminder\s*<\/button>/u);
  });

  it("includes status metrics for tools and orchestrations counts", () => {
    const html = renderConsole();
    // Status strip metric labels — capitalised plural forms.
    expect(html).toMatch(/<span>Tools<\/span>/u);
    expect(html).toMatch(/<span>Orchestrations<\/span>/u);
  });
});

