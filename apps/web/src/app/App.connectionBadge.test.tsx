import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App.js";

// Regression: the connection status badge used to render in BOTH the header
// (top-right) and the sidebar foot, so "Connected"/"연결됨" showed twice on
// screen at once. The sidebar-foot instance is the pre-existing home (next to
// the EN/한 toggle); the header instance was removed. Static-render `App` —
// data fetching happens in effects, which don't run under
// `renderToStaticMarkup`, so this only exercises the initial (pre-fetch) DOM
// shape, which is exactly what's needed to count badge instances.
describe("App — connection status badge renders exactly once", () => {
  it("shows a single .badge (the sidebar-foot ConnectionBadge), not one per header + sidebar", () => {
    const html = renderToStaticMarkup(<App />);
    const badgeCount = (html.match(/class="badge(?:\s[a-z]+)?"/g) ?? []).length;
    expect(badgeCount).toBe(1);
  });

  it("the surviving badge is inside the sidebar foot, not the topbar header", () => {
    const html = renderToStaticMarkup(<App />);
    const sidebarFootIdx = html.indexOf('class="sidebar-foot"');
    const mainIdx = html.indexOf("<main");
    expect(sidebarFootIdx).toBeGreaterThan(-1);
    expect(mainIdx).toBeGreaterThan(sidebarFootIdx);
    expect(html.slice(sidebarFootIdx, mainIdx)).toContain('class="badge');

    const headerIdx = html.indexOf('<header class="topbar">');
    const headerEndIdx = html.indexOf("</header>", headerIdx);
    expect(html.slice(headerIdx, headerEndIdx)).not.toContain('class="badge');
  });
});
