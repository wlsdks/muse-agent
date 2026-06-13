import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarNav } from "./App.js";

import type { Translate } from "../i18n/index.js";

const t = ((key: string) => key) as unknown as Translate;

// The active label is the one in the same <button> as aria-current="page".
function activeLabel(html: string): string | undefined {
  return /aria-current="page"[\s\S]*?<span>([^<]+)<\/span>/.exec(html)?.[1];
}

describe("SidebarNav — a11y semantics for the primary navigation", () => {
  it("exposes a navigation landmark", () => {
    const html = renderToStaticMarkup(<SidebarNav view="today" taskCount={0} t={t} onSelect={() => {}} />);
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="nav.primary"');
  });

  it("marks exactly the active view with aria-current=page, and it moves with `view`", () => {
    const todayHtml = renderToStaticMarkup(<SidebarNav view="today" taskCount={0} t={t} onSelect={() => {}} />);
    expect((todayHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(activeLabel(todayHtml)).toBe("nav.today");

    const dashHtml = renderToStaticMarkup(<SidebarNav view="dashboard" taskCount={0} t={t} onSelect={() => {}} />);
    expect((dashHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(activeLabel(dashHtml)).toBe("nav.dashboard");
  });
});
