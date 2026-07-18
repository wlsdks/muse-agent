import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarNav } from "./App.js";
import { DICTIONARIES } from "../i18n/strings.js";

import type { StringKey } from "../i18n/index.js";

const t = (key: StringKey) => DICTIONARIES.en[key];

describe("SidebarNav — rail mode tooltips", () => {
  it("collapsed: every item carries its label as a native tooltip (labels are hidden in the rail)", () => {
    const html = renderToStaticMarkup(
      <SidebarNav view="home" taskCount={0} t={t as never} onSelect={() => {}} collapsed />
    );
    expect(html).toContain('title="Home"');
    expect(html).toContain('title="Builder"');
  });

  it("expanded: no tooltips (labels are visible, a tooltip would be noise)", () => {
    const html = renderToStaticMarkup(
      <SidebarNav view="home" taskCount={0} t={t as never} onSelect={() => {}} />
    );
    expect(html).not.toContain('title="Home"');
  });
});
