import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  backupPlaintextCredentialsFile,
  credentialEncryptionEnabled,
  decodeMaybeEncryptedCredentialsJson,
  decryptCredentialEnvelope,
  encryptCredentialEnvelope,
  isCredentialsFileEncryptedAtRest,
  isEncryptedCredentialEnvelope
} from "./credential-encryption.js";

describe("credential-encryption envelope round-trip", () => {
  it("decryptCredentialEnvelope inverts encryptCredentialEnvelope", () => {
    const env = { MUSE_MEMORY_KEY: "test-key" };
    const envelope = encryptCredentialEnvelope("sk-secret-token", env);
    expect(isEncryptedCredentialEnvelope(envelope)).toBe(true);
    expect(decryptCredentialEnvelope(envelope, env)).toBe("sk-secret-token");
  });

  it("a wrong key THROWS (fail-closed) rather than returning garbage or empty", () => {
    const envelope = encryptCredentialEnvelope("payload", { MUSE_MEMORY_KEY: "right-key" });
    expect(() => decryptCredentialEnvelope(envelope, { MUSE_MEMORY_KEY: "wrong-key" })).toThrow();
  });

  it("isEncryptedCredentialEnvelope rejects plaintext JSON shapes", () => {
    expect(isEncryptedCredentialEnvelope({ providers: {} })).toBe(false);
    expect(isEncryptedCredentialEnvelope(null)).toBe(false);
    expect(isEncryptedCredentialEnvelope("a string")).toBe(false);
  });
});

describe("credentialEncryptionEnabled", () => {
  it("recognizes true/1/yes/on (case-insensitive) and defaults false", () => {
    expect(credentialEncryptionEnabled({})).toBe(false);
    for (const value of ["true", "TRUE", "1", "yes", "on"]) {
      expect(credentialEncryptionEnabled({ MUSE_CREDENTIALS_ENCRYPT: value })).toBe(true);
    }
    expect(credentialEncryptionEnabled({ MUSE_CREDENTIALS_ENCRYPT: "false" })).toBe(false);
  });
});

describe("decodeMaybeEncryptedCredentialsJson", () => {
  it("passes plaintext JSON through unchanged", () => {
    const parsed = { providers: { openai: { token: "sk-1" } } };
    expect(decodeMaybeEncryptedCredentialsJson(parsed, {})).toEqual(parsed);
  });

  it("decrypts an envelope back to its parsed plaintext JSON", () => {
    const env = { MUSE_MEMORY_KEY: "k" };
    const plaintext = { providers: { openai: { token: "sk-1" } } };
    const envelope = encryptCredentialEnvelope(JSON.stringify(plaintext), env);
    expect(decodeMaybeEncryptedCredentialsJson(envelope, env)).toEqual(plaintext);
  });

  it("propagates a decrypt failure (wrong key) instead of swallowing it", () => {
    const envelope = encryptCredentialEnvelope(JSON.stringify({ providers: {} }), { MUSE_MEMORY_KEY: "right" });
    expect(() => decodeMaybeEncryptedCredentialsJson(envelope, { MUSE_MEMORY_KEY: "wrong" })).toThrow();
  });
});

describe("isCredentialsFileEncryptedAtRest", () => {
  it("is false for a missing file, false for plaintext, true for an envelope — no key needed", async () => {
    expect(await isCredentialsFileEncryptedAtRest("/nonexistent/creds.json")).toBe(false);

    const plainFile = freshFile();
    writeFileSync(plainFile, JSON.stringify({ providers: {} }), "utf8");
    expect(await isCredentialsFileEncryptedAtRest(plainFile)).toBe(false);

    const encFile = freshFile();
    const envelope = encryptCredentialEnvelope("{}", { MUSE_MEMORY_KEY: "k" });
    writeFileSync(encFile, JSON.stringify(envelope), "utf8");
    expect(await isCredentialsFileEncryptedAtRest(encFile)).toBe(true);
  });
});

describe("backupPlaintextCredentialsFile", () => {
  it("skips backing up empty/whitespace-only content", async () => {
    const file = freshFile();
    expect(await backupPlaintextCredentialsFile(file, "")).toBeUndefined();
    expect(await backupPlaintextCredentialsFile(file, "   ")).toBeUndefined();
  });

  it("writes a .plaintext-backup-<ts> sibling with 0o600 containing the original content", async () => {
    const file = freshFile();
    const backupPath = await backupPlaintextCredentialsFile(file, JSON.stringify({ providers: { openai: { token: "sk-1" } } }));
    expect(backupPath).toBeDefined();
    const content = readFileSync(backupPath!, "utf8");
    expect(content).toContain("sk-1");
    if (process.platform !== "win32") {
      expect(statSync(backupPath!).mode & 0o777).toBe(0o600);
    }
  });
});

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cred-enc-")), "creds.json");
}
