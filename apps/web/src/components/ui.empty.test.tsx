import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AsyncBlock, Empty, Icon } from "./ui.js";
import { I18nProvider } from "../i18n/index.js";

import type { ReactNode } from "react";

const noop = () => {};

function render(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe("Empty — optional call-to-action", () => {
  it("renders a real <button> CTA with its label when an onClick action is given", () => {
    const html = render(
      <Empty action={{ label: "Add your first task", onClick: noop }}>No tasks yet.</Empty>
    );
    expect(html).toContain("No tasks yet.");
    // A real, focusable button (not a div) — keyboard + screen-reader reachable.
    expect(html).toContain("<button");
    expect(html).toContain("btn-primary");
    expect(html).toContain("Add your first task");
    expect(html).toContain("empty-action");
  });

  it("renders an anchor (not a button) when the action is an href link", () => {
    const html = render(<Empty action={{ href: "#settings", label: "Connect" }}>Nothing here.</Empty>);
    expect(html).toContain('href="#settings"');
    expect(html).toContain("Connect");
  });

  it("keeps the no-action form intact when no action is given (backward compatible)", () => {
    const html = render(<Empty>Nothing here yet.</Empty>);
    expect(html).toContain("Nothing here yet.");
    expect(html).not.toContain("empty-action");
    expect(html).not.toContain("<button");
  });

  it("still renders the icon and hint alongside the action", () => {
    const html = render(
      <Empty icon={<Icon.brain />} hint="Start a chat" action={{ label: "Start", onClick: noop }}>
        Muse hasn't learned anything yet.
      </Empty>
    );
    expect(html).toContain("empty-hint");
    expect(html).toContain("Start a chat");
    expect(html).toContain("empty-ic");
    expect(html).toContain("Start");
  });
});

describe("AsyncBlock — empty state forwards label + action", () => {
  it("renders the emptyLabel and emptyAction CTA when empty (a fresh install is guided, not blank)", () => {
    const html = render(
      <AsyncBlock
        loading={false}
        empty
        emptyLabel="No reminders yet."
        emptyAction={{ label: "Add your first reminder", onClick: noop }}
      >
        <div>rows</div>
      </AsyncBlock>
    );
    expect(html).toContain("No reminders yet.");
    expect(html).toContain("Add your first reminder");
    expect(html).toContain("<button");
    expect(html).not.toContain("rows");
  });

  it("falls back to the generic empty label when none is supplied", () => {
    const html = render(
      <AsyncBlock loading={false} empty>
        <div>rows</div>
      </AsyncBlock>
    );
    expect(html).toContain("Nothing here yet.");
    expect(html).not.toContain("empty-action");
  });

  it("renders children (no CTA) when not empty", () => {
    const html = render(
      <AsyncBlock loading={false} empty={false} emptyAction={{ label: "CTA", onClick: noop }}>
        <div>real content</div>
      </AsyncBlock>
    );
    expect(html).toContain("real content");
    expect(html).not.toContain("CTA");
  });

  it("shows the error state (not the empty CTA) when the query errored", () => {
    const html = render(
      <AsyncBlock loading={false} error={new Error("boom")} empty emptyAction={{ label: "CTA", onClick: noop }}>
        <div>rows</div>
      </AsyncBlock>
    );
    expect(html).toContain("empty err");
    expect(html).not.toContain("CTA");
  });
});
