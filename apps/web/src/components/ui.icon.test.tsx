import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Icon } from "./ui.js";

// Icons are decorative — they sit beside visible text or inside icon-only
// buttons whose accessible name comes from `title`. They must be hidden from
// the a11y tree so a screen reader doesn't announce a stray unlabeled graphic.
describe("Icon — decorative SVGs are hidden from the accessibility tree", () => {
  it("every icon carries aria-hidden and is not focusable", () => {
    for (const render of [Icon.plus, Icon.trash, Icon.send, Icon.check]) {
      const out = renderToStaticMarkup(render({}));
      expect(out).toContain('aria-hidden="true"');
      expect(out).toContain('focusable="false"');
    }
  });
});
