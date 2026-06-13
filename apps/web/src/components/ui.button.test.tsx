import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button, Icon } from "./ui.js";

// Icon-only buttons (Chat send/mic/speak) have no visible text, so their
// accessible name must come from an explicit aria-label — `title` alone is a
// tooltip that many screen readers don't announce (and never on touch). WCAG
// 4.1.2 (Name, Role, Value).
describe("Button — icon-only buttons carry a robust accessible name", () => {
  it("forwards ariaLabel to the rendered aria-label", () => {
    const html = renderToStaticMarkup(
      <Button ariaLabel="Send" title="Send">
        <Icon.send />
      </Button>
    );
    expect(html).toContain('aria-label="Send"');
  });

  it("omits aria-label entirely when none is given (text buttons keep their name from children)", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).not.toContain("aria-label");
  });
});
