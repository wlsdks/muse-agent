import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Brand } from "./App.js";

import type { Translate } from "../i18n/index.js";

const t = ((key: string) => (key === "brand.sub" ? "AI 지휘자" : key)) as unknown as Translate;

function sub(html: string): string | undefined {
  return /class="brand-sub">([^<]*)</.exec(html)?.[1];
}

describe("Brand — personalized tagline with the static i18n subtitle as instant fallback", () => {
  it("shows the static i18n subtitle when no tagline has loaded yet", () => {
    const html = renderToStaticMarkup(<Brand t={t} />);
    expect(sub(html)).toBe("AI 지휘자");
  });

  it("shows the personalized tagline when present", () => {
    const html = renderToStaticMarkup(<Brand tagline="커피 담당" t={t} />);
    expect(sub(html)).toBe("커피 담당");
  });

  it("falls back to the static subtitle for an empty/whitespace tagline (never blank)", () => {
    expect(sub(renderToStaticMarkup(<Brand tagline="" t={t} />))).toBe("AI 지휘자");
    expect(sub(renderToStaticMarkup(<Brand tagline="   " t={t} />))).toBe("AI 지휘자");
  });
});
