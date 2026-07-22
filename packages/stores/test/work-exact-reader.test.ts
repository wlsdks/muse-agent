import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encryptMemoryEnvelope, memoryEncryptionSecret } from "@muse/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  encryptWorksAtRest,
  mutateWorks,
  linkWorkFlow,
  linkWorkBoardTask,
  addWorkOutcome,
  readExactWork,
  readExactWorkCatalog,
  updateWork,
  writeWorks,
  WorkExactReadError
} from "../src/works-store.js";

const WORK_ID = "work_123e4567-e89b-4d3a-a456-426614174000";
const record = {
  boardTaskIds: [],
  createdAtIso: "2026-07-22T00:00:00.000Z",
  flowIds: [],
  goal: "Ship strict continuity",
  id: WORK_ID,
  name: "Work continuity",
  outcomes: [],
  status: "active",
  updatedAtIso: "2026-07-22T00:00:00.000Z"
};

function canonicalId(index: number): string {
  const hex = index.toString(16);
  return `work_${hex.padStart(8, "0")}-0000-4000-8000-${hex.padStart(12, "0")}`;
}

function encryptedBytesEnvelope(bytes: Buffer, env: NodeJS.ProcessEnv) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(memoryEncryptionSecret(env), salt, 32), iv);
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    data: data.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    version: 1
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-work-exact-"));
  file = join(dir, "works.json");
});

afterEach(async () => rm(dir, { force: true, recursive: true }));

describe("exact Work store", () => {
  it("reads exact legacy and v1 catalogs without changing bytes", async () => {
    for (const root of [{ works: [record] }, { version: 1, works: [record] }]) {
      await writeFile(file, `${JSON.stringify(root, null, 2)}\n`, "utf8");
      const before = await readFile(file);
      await expect(readExactWorkCatalog(file)).resolves.toEqual([record]);
      await expect(readExactWork(file, WORK_ID)).resolves.toEqual(record);
      expect(await readFile(file)).toEqual(before);
    }
  });

  it("rejects duplicate keys, unknown keys, malformed siblings, and future versions without writes", async () => {
    const invalid = [
      `{"works":[],"works":[]}`,
      JSON.stringify({ extra: true, works: [] }),
      JSON.stringify({ works: [record, { ...record, id: "bad" }] }),
      JSON.stringify({ version: 2, works: [] })
    ];
    for (const text of invalid) {
      await writeFile(file, text, "utf8");
      const before = await readFile(file);
      await expect(readExactWorkCatalog(file)).rejects.toThrow(WorkExactReadError);
      expect(await readFile(file)).toEqual(before);
    }
  });

  it("migrates a valid legacy store to inner v1 on mutation and preserves encryption", async () => {
    await writeFile(file, `${JSON.stringify({ works: [record] }, null, 2)}\n`, "utf8");
    await encryptWorksAtRest(file, { ...process.env, MUSE_MEMORY_KEY: "test-key" });
    await updateWork(file, WORK_ID, { name: "Renamed" }, { ...process.env, MUSE_MEMORY_KEY: "test-key" });
    expect(JSON.parse((await readFile(file, "utf8"))).algorithm).toBe("aes-256-gcm");
    await expect(readExactWork(file, WORK_ID, { ...process.env, MUSE_MEMORY_KEY: "test-key" }))
      .resolves.toMatchObject({ name: "Renamed" });
  });

  it("fails closed on a wrong key and preserves ciphertext bytes", async () => {
    await writeFile(file, `${JSON.stringify({ version: 1, works: [record] }, null, 2)}\n`, "utf8");
    await encryptWorksAtRest(file, { ...process.env, MUSE_MEMORY_KEY: "right" });
    const before = await readFile(file);
    await expect(readExactWorkCatalog(file, { ...process.env, MUSE_MEMORY_KEY: "wrong" }))
      .rejects.toThrow(WorkExactReadError);
    expect(await readFile(file)).toEqual(before);
  });

  it("rejects unknown envelope keys, non-canonical base64, and wrong nonce lengths", async () => {
    const env = { ...process.env, MUSE_MEMORY_KEY: "test-key" };
    const plaintext = `${JSON.stringify({ version: 1, works: [record] })}\n`;
    const envelope = encryptMemoryEnvelope(plaintext, env);
    const invalid = [
      { ...envelope, extra: true },
      { ...envelope, data: `${envelope.data}\n` },
      { ...envelope, iv: Buffer.alloc(11).toString("base64") }
    ];
    for (const value of invalid) {
      await writeFile(file, JSON.stringify(value), "utf8");
      const before = await readFile(file);
      await expect(readExactWorkCatalog(file, env)).rejects.toThrow(WorkExactReadError);
      expect(await readFile(file)).toEqual(before);
    }
  });

  it("validates the complete next catalog before an ordinary mutation writes", async () => {
    await writeFile(file, `${JSON.stringify({ version: 1, works: [record] }, null, 2)}\n`, "utf8");
    const before = await readFile(file);
    await expect(mutateWorks(file, (works) => [...works, { ...record, id: "not-canonical" }]))
      .rejects.toThrow(WorkExactReadError);
    expect(await readFile(file)).toEqual(before);
    await expect(mutateWorks(file, (works) => works.map((work) => ({ ...work, goal: "x".repeat(16 * 1024 * 1024) }))))
      .rejects.toThrow(/plaintext exceeds/u);
    expect(await readFile(file)).toEqual(before);
  });

  it("enforces 2,000/2,001 catalog and 500/501 per-record boundaries", async () => {
    const works = Array.from({ length: 2_000 }, (_, index) => ({ ...record, id: canonicalId(index + 1) }));
    await writeFile(file, JSON.stringify({ version: 1, works }), "utf8");
    await expect(readExactWorkCatalog(file)).resolves.toHaveLength(2_000);
    await writeFile(file, JSON.stringify({ version: 1, works: [...works, { ...record, id: canonicalId(2_001) }] }), "utf8");
    await expect(readExactWorkCatalog(file)).rejects.toThrow(WorkExactReadError);

    const fiveHundred = Array.from({ length: 500 }, (_, index) => `id_${index.toString()}`);
    const outcomes = fiveHundred.map(() => ({ atIso: record.updatedAtIso, kind: "used" }));
    await writeFile(file, JSON.stringify({ version: 1, works: [{ ...record, boardTaskIds: fiveHundred, flowIds: fiveHundred, outcomes }] }), "utf8");
    await expect(readExactWorkCatalog(file)).resolves.toHaveLength(1);
    for (const patch of [
      { flowIds: [...fiveHundred, "overflow"] },
      { boardTaskIds: [...fiveHundred, "overflow"] },
      { outcomes: [...outcomes, { atIso: record.updatedAtIso, kind: "used" }] }
    ]) {
      await writeFile(file, JSON.stringify({ version: 1, works: [{ ...record, ...patch }] }), "utf8");
      await expect(readExactWorkCatalog(file)).rejects.toThrow(WorkExactReadError);
    }
  });

  it("rejects production link/outcome mutations at item 501 without changing bytes", async () => {
    const ids = Array.from({ length: 500 }, (_, index) => `id_${index.toString()}`);
    const outcomes = ids.map(() => ({ atIso: record.updatedAtIso, kind: "used" as const }));
    await writeWorks(file, [{ ...record, flowIds: ids }]);
    let before = await readFile(file);
    await expect(linkWorkFlow(file, WORK_ID, "overflow", () => true)).rejects.toThrow(WorkExactReadError);
    expect(await readFile(file)).toEqual(before);

    await writeWorks(file, [{ ...record, boardTaskIds: ids }]);
    before = await readFile(file);
    await expect(linkWorkBoardTask(file, WORK_ID, "overflow", () => true)).rejects.toThrow(WorkExactReadError);
    expect(await readFile(file)).toEqual(before);

    await writeWorks(file, [{ ...record, outcomes }]);
    before = await readFile(file);
    await expect(addWorkOutcome(file, WORK_ID, { kind: "used" })).rejects.toThrow(WorkExactReadError);
    expect(await readFile(file)).toEqual(before);
  });

  it("rejects physical/plaintext/ciphertext caps and invalid outer/decrypted UTF-8", async () => {
    await writeFile(file, Buffer.alloc(24 * 1024 * 1024 + 1, 0x20));
    await expect(readExactWorkCatalog(file)).rejects.toThrow(/physical size/u);
    await writeFile(file, JSON.stringify({ version: 1, works: [{ ...record, goal: "x".repeat(16 * 1024 * 1024) }] }), "utf8");
    await expect(readExactWorkCatalog(file)).rejects.toThrow(/plaintext exceeds/u);
    await writeFile(file, JSON.stringify({
      ...encryptMemoryEnvelope("{}", { ...process.env, MUSE_MEMORY_KEY: "key" }),
      data: Buffer.alloc(16 * 1024 * 1024 + 1).toString("base64")
    }), "utf8");
    await expect(readExactWorkCatalog(file, { ...process.env, MUSE_MEMORY_KEY: "key" })).rejects.toThrow(WorkExactReadError);
    await writeFile(file, Buffer.from([0xff]));
    await expect(readExactWorkCatalog(file)).rejects.toThrow(/UTF-8/u);
    const env = { ...process.env, MUSE_MEMORY_KEY: "key" };
    await writeFile(file, JSON.stringify(encryptedBytesEnvelope(Buffer.from([0xff]), env)), "utf8");
    await expect(readExactWorkCatalog(file, env)).rejects.toThrow(/decrypted Work store is not valid UTF-8/u);
  });

  it("rejects ciphertext tamper, duplicate ids, parser-depth abuse, timestamps, and outcomes byte-stably", async () => {
    const env = { ...process.env, MUSE_MEMORY_KEY: "key" };
    const envelope = encryptMemoryEnvelope(JSON.stringify({ version: 1, works: [record] }), env);
    const replacement = envelope.data.startsWith("A") ? "B" : "A";
    await writeFile(file, JSON.stringify({ ...envelope, data: `${replacement}${envelope.data.slice(1)}` }), "utf8");
    const tampered = await readFile(file);
    await expect(readExactWorkCatalog(file, env)).rejects.toThrow(/could not be decrypted/u);
    expect(await readFile(file)).toEqual(tampered);

    const invalidRoots = [
      { version: 1, works: [record, record] },
      { version: 1, works: [{ ...record, updatedAtIso: "yesterday" }] },
      { version: 1, works: [{ ...record, outcomes: [{ atIso: record.updatedAtIso, kind: "invented" }] }] },
      { extra: [[[[[[[[[0]]]]]]]]], version: 1, works: [] }
    ];
    for (const root of invalidRoots) {
      await writeFile(file, JSON.stringify(root), "utf8");
      const before = await readFile(file);
      await expect(readExactWorkCatalog(file)).rejects.toThrow(WorkExactReadError);
      expect(await readFile(file)).toEqual(before);
    }
  });

  it("enforces strict parser node and object-member budgets byte-stably", async () => {
    const tooManyNodes = {
      extra: Array.from({ length: 1_001 }, () => Array.from({ length: 1_000 }, () => 0)),
      version: 1,
      works: []
    };
    const tooManyMembers = {
      ...Object.fromEntries(Array.from({ length: 2_003 }, (_, index) => [`extra_${index.toString()}`, index])),
      version: 1,
      works: []
    };
    for (const root of [tooManyNodes, tooManyMembers]) {
      await writeFile(file, JSON.stringify(root), "utf8");
      const before = await readFile(file);
      await expect(readExactWorkCatalog(file)).rejects.toThrow(WorkExactReadError);
      expect(await readFile(file)).toEqual(before);
    }
  }, 30_000);
});
