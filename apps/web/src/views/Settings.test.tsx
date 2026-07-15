import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuietHoursControl } from "./Settings.js";
import { createApiClient } from "../api/client.js";
import { DICTIONARIES } from "../i18n/strings.js";
import { I18nProvider } from "../i18n/index.js";

// Statically rendered — effects don't run under renderToStaticMarkup, so
// useQuery sits in its initial (loading, data undefined) state. The control
// falls back to its defaults in that state (enabled=false, range placeholder),
// which is exactly what a first-load-before-fetch-resolves view shows, so
// asserting against it is asserting real markup, not a mirror copy.
function render(): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createApiClient("http://127.0.0.1:3030", "");
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <QuietHoursControl client={client} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

describe("QuietHoursControl — the R3-4 live control (R2-4's read-only card upgraded)", () => {
  it("renders an editable range input with a bound label", () => {
    const html = render();
    expect(html).toMatch(/<input\b[^>]*\bid="quiet-hours-range"/u);
    expect(html).toMatch(/<label\b[^>]*\bhtmlFor="quiet-hours-range"|for="quiet-hours-range"/u);
  });

  it("renders an enable/disable toggle AND a save button — this is now a control, not a status line", () => {
    const html = render();
    const buttonCount = (html.match(/<button/gu) ?? []).length;
    expect(buttonCount).toBeGreaterThanOrEqual(2);
  });

  it("shows the not-set copy before the fetch resolves", () => {
    const html = render();
    expect(html).toContain(DICTIONARIES.en["settings.quietHoursNotSet"]);
  });

  it("EN and KO copy differ for every quiet-hours string key", () => {
    for (const key of [
      "settings.quietHours",
      "settings.sec.quietHours",
      "settings.quietHoursNotSet",
      "settings.quietHoursRange",
      "settings.quietHoursEnvWins",
      "settings.quietHoursInvalid"
    ] as const) {
      expect(DICTIONARIES.en[key]).toBeTruthy();
      expect(DICTIONARIES.ko[key]).toBeTruthy();
      expect(DICTIONARIES.en[key]).not.toBe(DICTIONARIES.ko[key]);
    }
  });
});
