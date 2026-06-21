import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readImageAttachment } from "./chat-ink-core.js";

const REAL_RECEIPT = join(__dirname, "..", "scripts", "fixtures", "vision", "receipt.png");

describe("readImageAttachment — vision input gate fails CLOSED on non-image bytes (content-sniffed, not extension-trusted)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-chatimg-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("PASS: a real PNG fixture loads as image/png (no over-reject regression)", async () => {
    const p = join(dir, "receipt.png");
    await copyFile(REAL_RECEIPT, p);
    const result = await readImageAttachment(p);
    expect(result).not.toBeUndefined();
    expect(result?.mimeType).toBe("image/png");
    expect((result?.dataBase64.length ?? 0)).toBeGreaterThan(0);
  });

  it("DROP: note.png whose bytes are plain UTF-8 text is rejected (returns undefined, not bogus image/png)", async () => {
    const p = join(dir, "note.png");
    await writeFile(p, "this is just plain text, not an image at all\n", "utf8");
    const result = await readImageAttachment(p);
    expect(result).toBeUndefined();
  });

  it("RECONCILE: photo.png with JPEG header returns image/jpeg (sniffed), not image/png (extension)", async () => {
    const p = join(dir, "photo.png");
    await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]));
    const result = await readImageAttachment(p);
    expect(result).not.toBeUndefined();
    expect(result?.mimeType).toBe("image/jpeg");
  });

  it("rejects .txt extension before reading bytes", async () => {
    const p = join(dir, "note.txt");
    await writeFile(p, "hello\n", "utf8");
    const result = await readImageAttachment(p);
    expect(result).toBeUndefined();
  });

  it("rejects a 0-byte .png file", async () => {
    const p = join(dir, "empty.png");
    await writeFile(p, Buffer.alloc(0));
    const result = await readImageAttachment(p);
    expect(result).toBeUndefined();
  });
});
