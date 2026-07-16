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
    const homeHtml = renderToStaticMarkup(<SidebarNav view="home" taskCount={0} t={t} onSelect={() => {}} />);
    expect((homeHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(activeLabel(homeHtml)).toBe("nav.home");

    // dashboard is an engine-room (advanced) view — visible only in dev mode.
    const dashHtml = renderToStaticMarkup(<SidebarNav view="dashboard" taskCount={0} t={t} onSelect={() => {}} devMode />);
    expect((dashHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(activeLabel(dashHtml)).toBe("nav.dashboard");
  });

  it("hides engine-room views unless developer mode is on", () => {
    const defaultHtml = renderToStaticMarkup(<SidebarNav view="chat" taskCount={0} t={t} onSelect={() => {}} />);
    expect(defaultHtml).not.toContain("nav.dashboard");
    expect(defaultHtml).not.toContain("nav.promptLab");
    expect(defaultHtml).not.toContain("nav.scheduler");
    expect(defaultHtml).not.toContain("nav.today");
    // the companion core stays
    for (const core of ["nav.home", "nav.chat", "nav.notes", "nav.memory", "nav.continuity", "nav.integrations", "nav.settings"]) {
      expect(defaultHtml).toContain(core);
    }

    const devHtml = renderToStaticMarkup(<SidebarNav view="chat" taskCount={0} t={t} onSelect={() => {}} devMode />);
    expect(devHtml).toContain("nav.dashboard");
    expect(devHtml).toContain("nav.promptLab");
  });
});
