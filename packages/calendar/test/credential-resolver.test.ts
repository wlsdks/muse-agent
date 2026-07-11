import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createKeychainSource, type ArgvRunner } from "@muse/secrets";
import { clearSecretRegistryForTests, redactSecrets } from "@muse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileCalendarCredentialStore } from "../src/credential-store.js";
import { createCalendarSecretSources, resolveCalendarSecret } from "../src/credential-resolver.js";

describe("resolveCalendarSecret — vault-first, legacy store as fallback", () => {
  let dir: string;
  let store: FileCalendarCredentialStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-cal-secret-"));
    store = new FileCalendarCredentialStore(join(dir, "credentials.json"));
    clearSecretRegistryForTests();
  });

  afterEach(async () => {
    clearSecretRegistryForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("falls through to the legacy store when no vault is configured (ZERO breakage)", async () => {
    await store.save("google", { apiKey: "legacy-stored-key" });
    const value = await resolveCalendarSecret(store, "google", "apiKey", {
      env: {},
      useKeychain: false
    });
    expect(value).toBe("legacy-stored-key");
  });

  it("env vault wins over the legacy store and is registered for redaction", async () => {
    await store.save("google", { apiKey: "legacy-stored-key" });
    const value = await resolveCalendarSecret(store, "google", "apiKey", {
      env: { MUSE_SECRET_APIKEY: "env-vault-key" },
      useKeychain: false
    });
    expect(value).toBe("env-vault-key");
    expect(redactSecrets("token=env-vault-key")).toBe("token=‹secret:apiKey›");
  });

  it("keychain wins over the legacy store; the field name is passed as a literal argv element", async () => {
    await store.save("google", { apiKey: "legacy-stored-key" });
    let capturedArgs: readonly string[] = [];
    const runner: ArgvRunner = (_file, args) => {
      capturedArgs = args;
      return Promise.resolve({ stdout: "keychain-key\n" });
    };
    const value = await resolveCalendarSecret(store, "google", "apiKey", {
      env: {},
      keychain: createKeychainSource({ runner, service: () => "muse-calendar" })
    });
    expect(value).toBe("keychain-key");
    expect(capturedArgs).toEqual([
      "find-generic-password",
      "-w",
      "-s",
      "muse-calendar",
      "-a",
      "apiKey"
    ]);
  });

  it("returns undefined when no source holds the field (still no crash)", async () => {
    const value = await resolveCalendarSecret(store, "google", "missing", {
      env: {},
      useKeychain: false
    });
    expect(value).toBeUndefined();
  });
});

describe("createCalendarSecretSources platform gating", () => {
  let dir: string;
  let store: FileCalendarCredentialStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-cal-platform-"));
    store = new FileCalendarCredentialStore(join(dir, "credentials.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("darwin chain is env → keychain → store (unchanged)", () => {
    const ids = createCalendarSecretSources(store, { platform: "darwin" }).map((s) => s.id);
    expect(ids).toEqual(["env", "keychain", "calendar-store"]);
  });

  it("win32 chain omits the keychain source (no /usr/bin/security to spawn)", () => {
    const ids = createCalendarSecretSources(store, { platform: "win32" }).map((s) => s.id);
    expect(ids).toEqual(["env", "calendar-store"]);
  });

  it("linux chain omits the keychain source too", () => {
    const ids = createCalendarSecretSources(store, { platform: "linux" }).map((s) => s.id);
    expect(ids).toEqual(["env", "calendar-store"]);
  });

  it("explicit useKeychain: true includes it regardless of platform", () => {
    const ids = createCalendarSecretSources(store, { platform: "win32", useKeychain: true }).map((s) => s.id);
    expect(ids).toContain("keychain");
  });
});
