import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { decryptCalendarEnvelope, encryptCalendarEnvelope, isEncryptedCalendarEnvelope } from "./calendar-encryption.js";
import { LocalCalendarProvider } from "./local-provider.js";

// Behavioral round-trip coverage for calendar encryption-at-rest (D2-S5):
// event titles / locations / notes are private, so the store must be
// unreadable ciphertext on disk when MUSE_CALENDAR_ENCRYPT is on, and a
// wrong-key read must fail CLOSED (throw, never quarantine/wipe).

const dirs: string[] = [];
afterEach(() => { dirs.length = 0; });
const freshFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "muse-cal-enc-"));
  dirs.push(dir);
  return join(dir, "calendar.json");
};
const d = (iso: string): Date => new Date(iso);
const seq = () => { let n = 0; return () => `e${(n++).toString()}`; };

describe("calendar-encryption helper round-trip", () => {
  it("decryptCalendarEnvelope inverts encryptCalendarEnvelope", () => {
    const env = { MUSE_MEMORY_KEY: "test-key" };
    const envelope = encryptCalendarEnvelope("hi", env);
    expect(isEncryptedCalendarEnvelope(envelope)).toBe(true);
    expect(decryptCalendarEnvelope(envelope, env)).toBe("hi");
  });
});

describe("LocalCalendarProvider encryption-at-rest", () => {
  it("envelope round-trip: on-disk bytes are an envelope with no plaintext title/location, and read-back decrypts identically", async () => {
    const file = freshFile();
    const env = { MUSE_CALENDAR_ENCRYPT: "true", MUSE_MEMORY_KEY: "test-key" };
    const provider = new LocalCalendarProvider({ env, file, idFactory: seq() });

    await provider.createEvent({
      endsAt: d("2026-05-15T09:30:00Z"),
      location: "SecretHQ Building 7",
      startsAt: d("2026-05-15T09:00:00Z"),
      title: "Confidential board meeting"
    });

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("Confidential board meeting");
    expect(raw).not.toContain("SecretHQ Building 7");
    const parsed = JSON.parse(raw) as unknown;
    expect(isEncryptedCalendarEnvelope(parsed)).toBe(true);

    const reread = new LocalCalendarProvider({ env, file });
    const events = await reread.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-16T00:00:00Z") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      location: "SecretHQ Building 7",
      startsAt: d("2026-05-15T09:00:00Z"),
      title: "Confidential board meeting"
    });
  });

  it("wrong-key read fails CLOSED: throws (never returns []) and leaves the ciphertext on disk unchanged", async () => {
    const file = freshFile();
    const rightEnv = { MUSE_CALENDAR_ENCRYPT: "true", MUSE_MEMORY_KEY: "right-key" };
    const wrongEnv = { MUSE_CALENDAR_ENCRYPT: "true", MUSE_MEMORY_KEY: "wrong-key" };

    const writer = new LocalCalendarProvider({ env: rightEnv, file, idFactory: seq() });
    await writer.createEvent({ endsAt: d("2026-05-15T09:30:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "Therapy appointment" });

    const before = readFileSync(file, "utf8");
    expect(isEncryptedCalendarEnvelope(JSON.parse(before) as unknown)).toBe(true);

    const reader = new LocalCalendarProvider({ env: wrongEnv, file });
    await expect(reader.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-16T00:00:00Z") })).rejects.toThrow();

    const after = readFileSync(file, "utf8");
    expect(after).toBe(before);
    expect(isEncryptedCalendarEnvelope(JSON.parse(after) as unknown)).toBe(true);
  });

  it("plaintext path is unchanged with the flag unset, and format-preserving keeps an already-encrypted file encrypted", async () => {
    const file = freshFile();
    const plainEnv = {};
    const plainProvider = new LocalCalendarProvider({ env: plainEnv, file, idFactory: seq() });
    await plainProvider.createEvent({ endsAt: d("2026-05-15T09:30:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "Standup" });

    const raw = readFileSync(file, "utf8");
    expect(isEncryptedCalendarEnvelope(JSON.parse(raw) as unknown)).toBe(false);
    const events = await plainProvider.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-16T00:00:00Z") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Standup" });

    // now encrypt it once
    const encFile = freshFile();
    const encEnv = { MUSE_CALENDAR_ENCRYPT: "true", MUSE_MEMORY_KEY: "test-key" };
    const encProvider = new LocalCalendarProvider({ env: encEnv, file: encFile, idFactory: seq() });
    await encProvider.createEvent({ endsAt: d("2026-05-15T09:30:00Z"), startsAt: d("2026-05-15T09:00:00Z"), title: "Encrypted event" });
    expect(isEncryptedCalendarEnvelope(JSON.parse(readFileSync(encFile, "utf8")) as unknown)).toBe(true);

    // write again with the flag UNSET (key still supplied — the flag only
    // controls whether a NEW write encrypts, not which key decrypts an
    // already-encrypted file) — format-preserving must keep it an envelope
    const laterProvider = new LocalCalendarProvider({ env: { MUSE_MEMORY_KEY: "test-key" }, file: encFile, idFactory: seq() });
    await laterProvider.createEvent({ endsAt: d("2026-05-16T09:30:00Z"), startsAt: d("2026-05-16T09:00:00Z"), title: "Second encrypted event" });
    const stillEncrypted = readFileSync(encFile, "utf8");
    expect(isEncryptedCalendarEnvelope(JSON.parse(stillEncrypted) as unknown)).toBe(true);

    // and it must still decrypt correctly with the right key even though the flag is now unset
    const finalReader = new LocalCalendarProvider({ env: { MUSE_MEMORY_KEY: "test-key" }, file: encFile });
    const finalEvents = await finalReader.listEvents({ from: d("2026-05-15T00:00:00Z"), to: d("2026-05-17T00:00:00Z") });
    expect(finalEvents).toHaveLength(2);
  });
});
