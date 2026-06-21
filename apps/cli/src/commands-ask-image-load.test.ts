import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadImageAttachment } from "./commands-ask.js";

const REAL_RECEIPT = join(__dirname, "..", "scripts", "fixtures", "vision", "receipt.png");

describe("loadImageAttachment — vision input gate fails CLOSED on non-image bytes (content-sniffed, not extension-trusted)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-imgload-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("PASS: a real checked-in PNG fixture loads as image/png (no over-reject regression)", async () => {
    const p = join(dir, "receipt.png");
    await copyFile(REAL_RECEIPT, p);
    const loaded = await loadImageAttachment(p);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.attachment.mimeType).toBe("image/png");
      expect(loaded.attachment.dataBase64.length).toBeGreaterThan(0);
    }
  });

  it("DROP 1 (the bug): note.png whose bytes are plain UTF-8 text is rejected, not shipped as bogus image/png", async () => {
    const p = join(dir, "note.png");
    await writeFile(p, "this is just plain text, not an image at all\n", "utf8");
    const loaded = await loadImageAttachment(p);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toMatch(/does not contain image data/i);
    }
  });

  it("DROP 2: photo.png whose bytes are a JPEG (extension≠content) is reconciled to the truthful image/jpeg", async () => {
    const p = join(dir, "photo.png");
    // Minimal JPEG SOI + APP0 header bytes — magic-byte recognisable as JPEG.
    await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]));
    const loaded = await loadImageAttachment(p);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.attachment.mimeType).toBe("image/jpeg");
    }
  });

  it("rejects a non-image extension (.txt) before reading bytes", async () => {
    const p = join(dir, "note.txt");
    await writeFile(p, "hello\n", "utf8");
    const loaded = await loadImageAttachment(p);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toMatch(/unsupported image type/i);
    }
  });

  it("rejects a 0-byte .png file", async () => {
    const p = join(dir, "empty.png");
    await writeFile(p, Buffer.alloc(0));
    const loaded = await loadImageAttachment(p);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toMatch(/empty \(0 bytes\)/i);
    }
  });
});
