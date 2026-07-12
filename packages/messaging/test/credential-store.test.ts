import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isEncryptedCredentialEnvelope } from "@muse/shared";

import { FileMessagingCredentialStore } from "../src/credential-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-cred-"));
  file = join(dir, "nested", "messaging.json"); // nested → exercises mkdir recursive
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("FileMessagingCredentialStore", () => {
  it("returns undefined for a provider in a not-yet-created store (ENOENT → empty, never throws)", async () => {
    const store = new FileMessagingCredentialStore(file);
    expect(await store.load("telegram")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("round-trips a saved credential and lists providers sorted", async () => {
    const store = new FileMessagingCredentialStore(file);
    await store.save("telegram", { token: "tg-123" });
    await store.save("discord", { token: "dc-456", botId: "b1" });
    expect(await store.load("telegram")).toEqual({ token: "tg-123" });
    expect(await store.list()).toEqual(["discord", "telegram"]); // sorted
  });

  it("merges a new provider without clobbering existing ones", async () => {
    const store = new FileMessagingCredentialStore(file);
    await store.save("telegram", { token: "a" });
    await store.save("slack", { token: "b" });
    expect(await store.load("telegram")).toEqual({ token: "a" });
    expect(await store.load("slack")).toEqual({ token: "b" });
  });

  it("writes the credential file with 0600 permissions (a bot token must not be world-readable)", async () => {
    const store = new FileMessagingCredentialStore(file);
    await store.save("telegram", { token: "secret" });
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("leaves no temp file behind after an atomic write", async () => {
    const store = new FileMessagingCredentialStore(file);
    await store.save("telegram", { token: "x" });
    const entries = await readdir(join(dir, "nested"));
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
    expect(entries).toContain("messaging.json");
  });

  it("removes an existing provider and is a silent no-op for an unknown one", async () => {
    const store = new FileMessagingCredentialStore(file);
    await store.save("telegram", { token: "a" });
    await store.save("slack", { token: "b" });
    await store.remove("telegram");
    expect(await store.load("telegram")).toBeUndefined();
    expect(await store.list()).toEqual(["slack"]);
    // removing a provider that isn't there resolves without throwing
    await expect(store.remove("never-added")).resolves.toBeUndefined();
    expect(await store.list()).toEqual(["slack"]); // unchanged
  });

  it("load returns a defensive copy — mutating the result does not corrupt the store", async () => {
    const store = new FileMessagingCredentialStore(file);
    await store.save("telegram", { token: "original" });
    const loaded = await store.load("telegram");
    (loaded as { token: string }).token = "tampered";
    expect(await store.load("telegram")).toEqual({ token: "original" });
  });

  it("treats a corrupt / non-object credential file as empty rather than crashing", async () => {
    const flat = join(dir, "corrupt.json");
    await writeFile(flat, "{ this is not json", "utf8");
    const store = new FileMessagingCredentialStore(flat);
    expect(await store.load("telegram")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    // a well-formed JSON value that lacks `providers` is also treated as empty
    await writeFile(flat, JSON.stringify({ version: 1 }), "utf8");
    expect(await store.list()).toEqual([]);
    // and the store can still save over the corrupt file
    await store.save("telegram", { token: "recovered" });
    expect(await store.load("telegram")).toEqual({ token: "recovered" });
  });
});

// Behavioral coverage for encryption-at-rest (security finding #4): channel bot
// tokens are high-value credentials, so the store must be unreadable ciphertext
// on disk when MUSE_CREDENTIALS_ENCRYPT is on, a wrong-key read must fail
// CLOSED, and an existing user's plaintext file must keep working untouched.
describe("FileMessagingCredentialStore encryption-at-rest", () => {
  it("plaintext default: with no key/flag, writes plaintext exactly as before (backward compatible)", async () => {
    const store = new FileMessagingCredentialStore(file, {});
    await store.save("telegram", { token: "tg-plain-token" });
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("tg-plain-token");
    expect(isEncryptedCredentialEnvelope(JSON.parse(raw) as unknown)).toBe(false);
  });

  it("legacy plaintext read still works when encryption is later enabled (format-preserving)", async () => {
    const plainStore = new FileMessagingCredentialStore(file, {});
    await plainStore.save("telegram", { token: "legacy-token" });

    const laterStore = new FileMessagingCredentialStore(file, { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "k" });
    expect(await laterStore.load("telegram")).toEqual({ token: "legacy-token" });
  });

  it("round-trip: on-disk bytes are ciphertext with no plaintext token, and read-back decrypts identically", async () => {
    const env = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "test-key" };
    const writer = new FileMessagingCredentialStore(file, env);
    await writer.save("telegram", { token: "tg-super-secret" });

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("tg-super-secret");
    const parsed = JSON.parse(raw) as unknown;
    expect(isEncryptedCredentialEnvelope(parsed)).toBe(true);

    const reader = new FileMessagingCredentialStore(file, env);
    expect(await reader.load("telegram")).toEqual({ token: "tg-super-secret" });
  });

  it("wrong-key read fails CLOSED: throws (never returns undefined/empty) and leaves the ciphertext on disk unchanged", async () => {
    const rightEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "right-key" };
    const wrongEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "wrong-key" };

    const writer = new FileMessagingCredentialStore(file, rightEnv);
    await writer.save("telegram", { token: "tg-secret" });

    const before = await readFile(file, "utf8");
    expect(isEncryptedCredentialEnvelope(JSON.parse(before) as unknown)).toBe(true);

    const reader = new FileMessagingCredentialStore(file, wrongEnv);
    await expect(reader.load("telegram")).rejects.toThrow();

    const after = await readFile(file, "utf8");
    expect(after).toBe(before);
  });

  it("format-preserving: once encrypted, stays encrypted even if the flag is later unset", async () => {
    const encEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "k" };
    const encStore = new FileMessagingCredentialStore(file, encEnv);
    await encStore.save("telegram", { token: "a" });
    expect(isEncryptedCredentialEnvelope(JSON.parse(await readFile(file, "utf8")) as unknown)).toBe(true);

    // flag unset, key still supplied — a later write must NOT silently decrypt at rest
    const laterStore = new FileMessagingCredentialStore(file, { MUSE_MEMORY_KEY: "k" });
    await laterStore.save("discord", { token: "b" });
    const raw = await readFile(file, "utf8");
    expect(isEncryptedCredentialEnvelope(JSON.parse(raw) as unknown)).toBe(true);

    const finalReader = new FileMessagingCredentialStore(file, { MUSE_MEMORY_KEY: "k" });
    expect(await finalReader.load("telegram")).toEqual({ token: "a" });
    expect(await finalReader.load("discord")).toEqual({ token: "b" });
  });

  it("backs up the pre-encryption plaintext on the FIRST transition, readable without the key", async () => {
    const plainStore = new FileMessagingCredentialStore(file, {});
    await plainStore.save("telegram", { token: "tg-before-encrypt" });

    const encStore = new FileMessagingCredentialStore(file, { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "k" });
    await encStore.save("telegram", { token: "tg-before-encrypt" });

    const entries = await readdir(join(dir, "nested"));
    const backups = entries.filter((e) => e.includes(".plaintext-backup-"));
    expect(backups).toHaveLength(1);
    const backupRaw = await readFile(join(dir, "nested", backups[0]!), "utf8");
    expect(backupRaw).toContain("tg-before-encrypt");
    expect(isEncryptedCredentialEnvelope(JSON.parse(backupRaw) as unknown)).toBe(false);
  });

  it("does NOT back up when a store is created encrypted from the start (nothing to lose)", async () => {
    const encStore = new FileMessagingCredentialStore(file, { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "k" });
    await encStore.save("telegram", { token: "fresh-secret" });
    const entries = await readdir(join(dir, "nested"));
    expect(entries.filter((e) => e.includes(".plaintext-backup-"))).toEqual([]);
  });
});
