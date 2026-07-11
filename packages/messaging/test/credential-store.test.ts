import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
