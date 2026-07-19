import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConnectionProvider } from "./connection-context.js";
import { AsyncBlock, LoadErrorState } from "./ui.js";
import { I18nProvider } from "../i18n/index.js";

import type { ConnectionState } from "./connection-context.js";
import type { ReactNode } from "react";

function render(node: ReactNode, connected: ConnectionState): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ConnectionProvider connected={connected}>{node}</ConnectionProvider>
    </I18nProvider>
  );
}

describe("LoadErrorState — offline is a calm, recognizable state, not a scary generic failure", () => {
  it("renders the calm offline state (plug icon, neutral tone) when the connection is definitively down", () => {
    const html = render(<LoadErrorState />, false);
    expect(html).toContain("Can&#x27;t reach Muse");
    expect(html).toContain("automatically once it&#x27;s back");
    expect(html).not.toContain("empty err");
    expect(html).not.toContain("Couldn&#x27;t load");
  });

  it("keeps the generic red error state byte-identical when the connection is known ok", () => {
    const html = render(<LoadErrorState />, true);
    expect(html).toContain("empty err");
    expect(html).toContain("Couldn&#x27;t load");
    expect(html).toContain("Check your connection and try again.");
    expect(html).not.toContain("Can&#x27;t reach Muse");
  });

  it("keeps the generic red error state when the connection state hasn't resolved yet (unknown)", () => {
    const html = render(<LoadErrorState />, undefined);
    expect(html).toContain("empty err");
    expect(html).toContain("Couldn&#x27;t load");
    expect(html).not.toContain("Can&#x27;t reach Muse");
  });
});

describe("AsyncBlock — error branch routes through LoadErrorState", () => {
  it("shows the calm offline state (not the generic alert) for a failed query while offline", () => {
    const html = render(
      <AsyncBlock loading={false} error={new Error("Failed to fetch")}>
        <div>rows</div>
      </AsyncBlock>,
      false
    );
    expect(html).toContain("Can&#x27;t reach Muse");
    expect(html).not.toContain("empty err");
  });

  it("shows the generic error state for a failed query while connected (some other request broke)", () => {
    const html = render(
      <AsyncBlock loading={false} error={new Error("boom")}>
        <div>rows</div>
      </AsyncBlock>,
      true
    );
    expect(html).toContain("empty err");
    expect(html).not.toContain("Can&#x27;t reach Muse");
  });
});
