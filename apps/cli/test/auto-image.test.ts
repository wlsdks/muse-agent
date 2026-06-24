import { describe, expect, it } from "vitest";

import { loadAutoImageAttachments, type AutoImageDeps } from "../src/auto-image.js";

const att = (id: string) => ({ mimeType: "image/png", dataBase64: id });

describe("loadAutoImageAttachments (MED-12 orchestration)", () => {
  it("loads every resolved candidate that loads successfully", async () => {
    const deps: AutoImageDeps = {
      resolve: () => ["/a.png", "/b.png"],
      loadImage: async (p) => ({ ok: true, attachment: att(p) })
    };
    const out = await loadAutoImageAttachments("see /a.png and /b.png", deps);
    expect(out.map((a) => a.dataBase64)).toEqual(["/a.png", "/b.png"]);
  });

  it("silently skips a candidate that fails to load (never errors the ask)", async () => {
    const deps: AutoImageDeps = {
      resolve: () => ["/good.png", "/bad.png"],
      loadImage: async (p) => (p === "/bad.png" ? { ok: false, error: "not an image" } : { ok: true, attachment: att(p) })
    };
    const out = await loadAutoImageAttachments("x", deps);
    expect(out.map((a) => a.dataBase64)).toEqual(["/good.png"]);
  });

  it("returns [] when no candidates are resolved", async () => {
    const deps: AutoImageDeps = { resolve: () => [], loadImage: async () => ({ ok: false, error: "n/a" }) };
    expect(await loadAutoImageAttachments("no images", deps)).toEqual([]);
  });
});
