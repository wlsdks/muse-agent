import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LangToggle } from "./App.js";

// The pressed button is the one carrying aria-pressed="true".
function pressedLabel(html: string): string | undefined {
  return /aria-pressed="true"[^>]*>\s*([^<\s][^<]*?)\s*</.exec(html)?.[1];
}

describe("LangToggle — selected language exposed via aria-pressed", () => {
  it("marks exactly the active language pressed, and it tracks `lang`", () => {
    const en = renderToStaticMarkup(<LangToggle lang="en" onChange={() => {}} />);
    expect((en.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect((en.match(/aria-pressed="false"/g) ?? []).length).toBe(1);
    expect(pressedLabel(en)).toBe("EN");

    const ko = renderToStaticMarkup(<LangToggle lang="ko" onChange={() => {}} />);
    expect((ko.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
    expect(pressedLabel(ko)).toBe("한");
  });
});
