import { Buffer } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildOllamaVisionBody,
  formatOllamaVisionFailure,
  loadImageAsBase64,
  resolveVisionModel
} from "./commands-vision.js";

function response(body: BodyInit | null, init: ResponseInit & { contentType?: string }): typeof fetch {
  const headers = init.contentType ? { "content-type": init.contentType } : undefined;
  return (async () => new Response(body, { ...init, ...(headers ? { headers } : {}) })) as unknown as typeof fetch;
}

describe("resolveVisionModel", () => {
  it("prefers the explicit flag, then env, then the default", () => {
    expect(resolveVisionModel("llava:13b", {})).toBe("llava:13b");
    expect(resolveVisionModel(" ", { MUSE_VISION_MODEL: "qwen2.5vl" })).toBe("qwen2.5vl");
    expect(resolveVisionModel(undefined, {})).toBe("llama3.2-vision:latest");
  });
});

describe("buildOllamaVisionBody", () => {
  it("packs the image as a single base64 entry with reasoning off and streaming disabled", () => {
    expect(buildOllamaVisionBody({ imageBase64: "QQ==", model: "m", prompt: "p" })).toEqual({
      images: ["QQ=="],
      model: "m",
      prompt: "p",
      stream: false,
      think: false
    });
  });
});

describe("formatOllamaVisionFailure", () => {
  it("turns a 404 into a concrete `ollama pull <base>` hint", () => {
    const msg = formatOllamaVisionFailure({ body: "not found", model: "llava:13b", status: 404 });
    expect(msg).toContain("not installed");
    expect(msg).toContain("ollama pull llava");
  });

  it("keeps the raw body for non-404 statuses", () => {
    expect(formatOllamaVisionFailure({ body: "boom", model: "m", status: 500 })).toContain("500");
  });
});

describe("loadImageAsBase64 — data URLs", () => {
  it("peels a valid base64 data URL", async () => {
    expect(await loadImageAsBase64("data:image/png;base64,QQ==")).toBe("QQ==");
  });

  it("rejects a non-base64 (URL-encoded / SVG) data URL", async () => {
    await expect(loadImageAsBase64("data:image/svg+xml,<svg></svg>")).rejects.toThrow(/base64-encoded image bytes/);
  });

  it("rejects an empty or malformed data URL payload", async () => {
    await expect(loadImageAsBase64("data:image/png;base64,")).rejects.toThrow(/empty or not valid base64/);
    await expect(loadImageAsBase64("data:image/png")).rejects.toThrow(/no comma separator/);
  });
});

describe("loadImageAsBase64 — http(s) URLs", () => {
  it("base64-encodes image bytes from a successful fetch", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = response(bytes, { contentType: "image/png", status: 200 });
    expect(await loadImageAsBase64("https://x.test/a.png", fetchImpl)).toBe(bytes.toString("base64"));
  });

  it("throws on a non-OK status", async () => {
    await expect(loadImageAsBase64("https://x.test/missing", response("nope", { status: 404 }))).rejects.toThrow(/returned 404/);
  });

  it("rejects a 200 response whose content-type is clearly textual (HTML error/login page)", async () => {
    const fetchImpl = response("<html>login</html>", { contentType: "text/html; charset=utf-8", status: 200 });
    await expect(loadImageAsBase64("https://x.test/login", fetchImpl)).rejects.toThrow(/not an image/);
  });

  it("allows octet-stream and an absent content-type (hosts that omit the image type)", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    expect(await loadImageAsBase64("https://x.test/a", response(bytes, { contentType: "application/octet-stream", status: 200 }))).toBe(
      bytes.toString("base64")
    );
    expect(await loadImageAsBase64("https://x.test/b", response(bytes, { status: 200 }))).toBe(bytes.toString("base64"));
  });
});

describe("loadImageAsBase64 — local path", () => {
  it("reads and base64-encodes a local file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-vision-"));
    const file = join(dir, "img.bin");
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
    expect(await loadImageAsBase64(file)).toBe(Buffer.from([0xff, 0xd8, 0xff]).toString("base64"));
  });
});
