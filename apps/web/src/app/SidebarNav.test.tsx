import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NAV, SidebarNav } from "./App.js";

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
    // demoted to advanced (2026-07-18 LNB reduction): setup-hub, not daily-life
    expect(defaultHtml).not.toContain("nav.integrations");
    // folded into the Builder as its Schedule tab (same reduction)
    expect(defaultHtml).not.toContain("nav.scheduled");
    // the companion core + life data stays
    for (const core of [
      "nav.home",
      "nav.chat",
      "nav.today",
      "nav.tasks",
      "nav.calendar",
      "nav.reminders",
      "nav.notes",
      "nav.memory",
      "nav.continuity",
      "nav.settings"
    ]) {
      expect(defaultHtml).toContain(core);
    }

    const devHtml = renderToStaticMarkup(<SidebarNav view="chat" taskCount={0} t={t} onSelect={() => {}} devMode />);
    expect(devHtml).toContain("nav.dashboard");
    expect(devHtml).toContain("nav.promptLab");
  });

  it("pins the LNB contract: the visible set, the My Life group, and group render order", () => {
    const visibleIds = NAV.filter((n) => !n.advanced).map((n) => n.id).sort();
    expect(visibleIds).toEqual(
      [
        "autonomy",
        "calendar",
        "flows",
        "chat",
        "continuity",
        "home",
        "memory",
        "notes",
        "reminders",
        "settings",
        "tasks",
        "today",
        "work"
      ].sort()
    );

    for (const id of ["tasks", "calendar", "reminders"] as const) {
      const entry = NAV.find((n) => n.id === id);
      expect(entry?.group).toBe("group.life");
      expect(entry?.advanced).toBeFalsy();
    }

    const groupOrder: string[] = [];
    for (const n of NAV) {
      if (!groupOrder.includes(n.group)) {
        groupOrder.push(n.group);
      }
    }
    expect(groupOrder.indexOf("group.workspace")).toBeLessThan(groupOrder.indexOf("group.life"));
    expect(groupOrder.indexOf("group.life")).toBeLessThan(groupOrder.indexOf("group.automation"));
    expect(groupOrder.indexOf("group.automation")).toBeLessThan(groupOrder.indexOf("group.knowledge"));
    expect(groupOrder.indexOf("group.knowledge")).toBeLessThan(groupOrder.indexOf("group.system"));

    for (const id of ["flows", "work"] as const) {
      const entry = NAV.find((n) => n.id === id);
      expect(entry?.group).toBe("group.automation");
      expect(entry?.advanced).toBeFalsy();
    }
  });
});
