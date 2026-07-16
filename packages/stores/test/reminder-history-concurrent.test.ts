import { randomUUID } from "node:crypto";
import { rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { appendReminderHistory, readReminderHistory, type ReminderHistoryEntry } from "../src/personal-reminder-history-store.js";

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-reminder-history-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => { await Promise.all(files.map((f) => rm(f, { force: true }))); files = []; });

const entry = (reminderId: string): ReminderHistoryEntry => ({
  destination: "555",
  firedAtIso: "2026-06-01T00:00:00Z",
  providerId: "telegram",
  reminderId,
  status: "delivered",
  text: `delivered ${reminderId}`
});

// appendReminderHistory is a read-modify-write. Before the per-file mutation queue,
// concurrent reminder fires lost records (last write clobbered the rest — a lost
// fire record can let a one-shot reminder re-fire) and crashed with ENOENT on the
// same-ms tmp-${pid}-${Date.now()} path.
describe("appendReminderHistory under concurrency", () => {
  it("preserves every concurrently-recorded fire (no lost record, no rename crash)", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 25 }, (_unused, i) => appendReminderHistory(file, entry(`r${i.toString()}`), { capacity: 100 })));
    const all = await readReminderHistory(file);
    expect(all).toHaveLength(25);
    expect(new Set(all.map((e) => e.reminderId)).size).toBe(25);
  }, 30_000);

  it("still honours the capacity cap (newest kept) under concurrent over-cap fires", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 30 }, (_unused, i) => appendReminderHistory(file, entry(`q${i.toString()}`), { capacity: 10 })));
    expect(await readReminderHistory(file)).toHaveLength(10);
  }, 30_000);

  it("preserves an external delivery committed while this process waits for the file lock", async () => {
    const file = freshFile();
    await appendReminderHistory(file, entry("local-first"));
    await writeFile(`${file}.lock`, "external writer", { flag: "wx" });
    const localDelivery = appendReminderHistory(file, entry("local-second"));
    await sleep(300);
    const first = (await readReminderHistory(file))[0]!;
    await writeFile(file, `${JSON.stringify({ entries: [first, entry("external")], version: 1 }, null, 2)}\n`);
    await unlink(`${file}.lock`);

    await localDelivery;
    expect((await readReminderHistory(file)).map(({ reminderId }) => reminderId)).toEqual(["local-second", "external", "local-first"]);
  });
});

describe("appendReminderHistory — scrubs credential shapes before persisting (parity with proactive-history)", () => {
  let f: string[] = [];
  const fresh = () => { const file = join(tmpdir(), `muse-reminder-redact-${randomUUID()}.json`); f.push(file); return file; };
  afterEach(async () => { await Promise.all(f.map((x) => rm(x, { force: true }))); f = []; });

  it("redacts an openai key in `text` and a telegram bot token in `error` (the audit log never stores the raw secret)", async () => {
    const file = fresh();
    const rawKey = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX"; // matches /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/
    const rawToken = "987654321:AAEoSDFGHjklMNOpqrsTUVwxyz123456789"; // \d{6,}:[A-Za-z0-9_-]{35}
    await appendReminderHistory(file, {
      destination: "555",
      error: `telegram 401: ${rawToken} rejected`,
      firedAtIso: "2026-06-01T00:00:00Z",
      providerId: "telegram",
      reminderId: "r1",
      status: "failed",
      text: `rotate key ${rawKey} now`
    });
    const [persisted] = await readReminderHistory(file);
    expect(persisted!.text).not.toContain(rawKey);
    expect(persisted!.text).toContain("[redacted-openai-key]");
    expect(persisted!.error).not.toContain(rawToken);
    expect(persisted!.error).toContain("[redacted-telegram-bot-token]");
  });
});
