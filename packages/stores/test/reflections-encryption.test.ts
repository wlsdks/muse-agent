import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptFileAtRest, isFileEncryptedAtRest } from "../src/encrypted-file.js";
import { addReflections, readReflections, type NewReflection } from "../src/reflections-store.js";

const KEY = { MUSE_MEMORY_KEY: "reflections-test-key-A" } as NodeJS.ProcessEnv;
const WRONG = { MUSE_MEMORY_KEY: "reflections-test-key-B" } as NodeJS.ProcessEnv;

let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "muse-reflections-enc-")); });
afterAll(async () => { await rm(dir, { force: true, recursive: true }); });
const freshFile = () => join(dir, `reflections-${randomUUID()}.json`);

const reflection = (id: string): NewReflection => ({
  createdAtMs: 100,
  id,
  insight: `the user runs every morning ${id}`,
  sourceIds: ["ep-1"],
  supportCount: 2
});

describe("reflections store encryption-at-rest (what Muse noticed about you — personal)", () => {
  it("round-trips: encrypt then read returns the same reflections; on-disk bytes are an envelope, not the insight", async () => {
    const file = freshFile();
    await addReflections(file, [reflection("a")], {}, KEY);
    expect(await isFileEncryptedAtRest(file)).toBe(false);

    const result = await encryptFileAtRest(file, KEY);
    expect(result.alreadyEncrypted).toBe(false);
    expect(await isFileEncryptedAtRest(file)).toBe(true);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as { algorithm?: string };
    expect(onDisk.algorithm).toBe("aes-256-gcm");
    expect(await readFile(file, "utf8")).not.toContain("runs every morning"); // ciphertext, not the insight

    const back = await readReflections(file, KEY);
    expect(back.map((r) => r.id)).toEqual(["a"]);
  });

  it("a WRONG key fails CLOSED (throws) — a decrypt with the wrong secret never returns plaintext", async () => {
    const file = freshFile();
    await addReflections(file, [reflection("a")], {}, KEY);
    await encryptFileAtRest(file, KEY);
    await expect(readReflections(file, WRONG)).rejects.toThrow();
  });

  it("preserves the encrypted format on a subsequent write (once encrypted, stays encrypted)", async () => {
    const file = freshFile();
    await addReflections(file, [reflection("a")], {}, KEY);
    await encryptFileAtRest(file, KEY);
    await addReflections(file, [reflection("b")], {}, KEY);
    expect(await isFileEncryptedAtRest(file)).toBe(true);
    const back = await readReflections(file, KEY);
    expect(back.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});
