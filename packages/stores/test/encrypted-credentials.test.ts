import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  credentialPath,
  deleteEmailImapCredential,
  deleteGmailCredential,
  hasStoredEmailImapCredentialSync,
  hasStoredGmailCredentialSync,
  readEmailImapCredential,
  readGmailCredential,
  readStoredToken,
  writeEmailImapCredential,
  writeGmailCredential,
  writeStoredToken,
  type CredentialStoreIO,
  type GmailOAuthCredential,
  type ImapEmailCredential
} from "../src/encrypted-credentials.js";

/**
 * Independently re-implements the pre-move `apps/cli/src/credential-store.ts`
 * encryption exactly (same scrypt-derived AES-256-GCM envelope, same
 * `{tokens, gmail?}` payload shape) so a "fixture written by the OLD code
 * path" exists without depending on that module having ever existed in this
 * checkout. Proves the moved `packages/stores` implementation reads the
 * SAME on-disk format byte-for-byte — no migration.
 */
function writeLegacyCredentialFile(filePath: string, credentialKey: string, payload: unknown): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(credentialKey, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const legacyFile = {
    algorithm: "aes-256-gcm",
    data: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    version: 1
  };
  return writeFile(filePath, `${JSON.stringify(legacyFile, null, 2)}\n`, "utf8");
}

describe("encrypted-credentials — byte-compatible with the pre-move on-disk format", () => {
  let workdir: string;
  const io = (): CredentialStoreIO => ({ configDir: workdir, credentialKey: "fixture-key-aaaaaaaaaaaaaaaaaa" });

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "muse-cred-fixture-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("decrypts a token store written by the OLD (legacy) format", async () => {
    await writeLegacyCredentialFile(credentialPath(io()), "fixture-key-aaaaaaaaaaaaaaaaaa", {
      tokens: { "https://api.example.com": { token: "legacy-token", updatedAt: "2026-01-01T00:00:00Z" } }
    });
    expect(await readStoredToken(io(), "https://api.example.com")).toBe("legacy-token");
  });

  it("decrypts a Gmail OAuth section written by the OLD (legacy) format — the field didn't exist in the earliest legacy stores, so absence must also read cleanly", async () => {
    const credential: GmailOAuthCredential = {
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret-value",
      refreshToken: "refresh-token-value"
    };
    await writeLegacyCredentialFile(credentialPath(io()), "fixture-key-aaaaaaaaaaaaaaaaaa", {
      gmail: credential,
      tokens: { "https://api.example.com": { token: "legacy-token", updatedAt: "2026-01-01T00:00:00Z" } }
    });
    expect(await readGmailCredential(io())).toEqual(credential);
    expect(hasStoredGmailCredentialSync(io())).toBe(true);

    // A legacy store with NO `gmail` key at all (pre-Gmail-field era) must
    // still decrypt cleanly and report "not configured", never throw.
    await writeLegacyCredentialFile(credentialPath(io()), "fixture-key-aaaaaaaaaaaaaaaaaa", {
      tokens: { "https://api.example.com": { token: "legacy-token", updatedAt: "2026-01-01T00:00:00Z" } }
    });
    expect(await readGmailCredential(io())).toBeUndefined();
    expect(hasStoredGmailCredentialSync(io())).toBe(false);
  });

  it("a fresh write from the MOVED module round-trips through BOTH token and Gmail sections, unchanged format", async () => {
    const credential: GmailOAuthCredential = {
      accessToken: "access-1",
      accessTokenExpiresAt: Date.now() + 3600_000,
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret-value",
      refreshToken: "refresh-token-value"
    };
    await writeStoredToken(io(), "https://api.example.com", "fresh-token");
    await writeGmailCredential(io(), credential);
    expect(await readStoredToken(io(), "https://api.example.com")).toBe("fresh-token");
    expect(await readGmailCredential(io())).toEqual(credential);

    await deleteGmailCredential(io());
    expect(await readGmailCredential(io())).toBeUndefined();
    expect(await readStoredToken(io(), "https://api.example.com")).toBe("fresh-token");
  });

  it("decrypts a store written by the OLD (pre-E2) format — no `emailImap` key at all — cleanly reporting not-configured", async () => {
    await writeLegacyCredentialFile(credentialPath(io()), "fixture-key-aaaaaaaaaaaaaaaaaa", {
      gmail: { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" },
      tokens: { "https://api.example.com": { token: "legacy-token", updatedAt: "2026-01-01T00:00:00Z" } }
    });
    expect(await readEmailImapCredential(io())).toBeUndefined();
    expect(hasStoredEmailImapCredentialSync(io())).toBe(false);
    // The Gmail OAuth section written by the SAME legacy file is unaffected.
    expect(await readGmailCredential(io())).toEqual({ clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" });
  });

  it("a fresh emailImap (App Password) write round-trips, coexists with an existing gmail section, and independent deletes don't disturb each other", async () => {
    const gmail: GmailOAuthCredential = { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" };
    const emailImap: ImapEmailCredential = { appPassword: "abcdabcdabcdabcd", email: "user@gmail.com" };
    await writeGmailCredential(io(), gmail);
    await writeEmailImapCredential(io(), emailImap);
    expect(await readGmailCredential(io())).toEqual(gmail);
    expect(await readEmailImapCredential(io())).toEqual(emailImap);
    expect(hasStoredEmailImapCredentialSync(io())).toBe(true);

    await deleteEmailImapCredential(io());
    expect(await readEmailImapCredential(io())).toBeUndefined();
    expect(hasStoredEmailImapCredentialSync(io())).toBe(false);
    // Deleting the App Password record must NOT touch the sibling OAuth record.
    expect(await readGmailCredential(io())).toEqual(gmail);
  });

  it("serializes concurrent token, Gmail, and IMAP writes without losing sibling credentials", async () => {
    const gmail: GmailOAuthCredential = { clientId: "cid", clientSecret: "csecret", refreshToken: "refresh" };
    const emailImap: ImapEmailCredential = { appPassword: "app-password", email: "user@example.com" };

    await Promise.all([
      writeStoredToken(io(), "https://api.example.com", "token"),
      writeGmailCredential(io(), gmail),
      writeEmailImapCredential(io(), emailImap)
    ]);

    expect(await readStoredToken(io(), "https://api.example.com")).toBe("token");
    expect(await readGmailCredential(io())).toEqual(gmail);
    expect(await readEmailImapCredential(io())).toEqual(emailImap);
  });

  it("preserves encrypted credentials when a write uses the wrong key", async () => {
    const file = credentialPath(io());
    await writeLegacyCredentialFile(file, "fixture-key-aaaaaaaaaaaaaaaaaa", {
      tokens: { "https://api.example.com": { token: "recoverable-token", updatedAt: "2026-01-01T00:00:00Z" } }
    });
    const original = await readFile(file, "utf8");
    const wrongKeyIo: CredentialStoreIO = { configDir: workdir, credentialKey: "different-key-bbbbbbbbbbbbbbbb" };

    await expect(writeStoredToken(wrongKeyIo, "https://api.example.com", "replacement-token")).rejects.toThrow(
      /Refusing to overwrite unreadable credentials/u
    );

    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readStoredToken(io(), "https://api.example.com")).toBe("recoverable-token");
  });

  it("does not overwrite an existing malformed credential store", async () => {
    const file = credentialPath(io());
    await writeFile(file, "not-json\n", "utf8");

    await expect(writeStoredToken(io(), "https://api.example.com", "replacement-token")).rejects.toThrow(
      /Refusing to overwrite unreadable credentials/u
    );

    expect(await readFile(file, "utf8")).toBe("not-json\n");
  });

  it("stores a non-Gmail IMAP host override (e.g. Naver) unchanged", async () => {
    const emailImap: ImapEmailCredential = { appPassword: "pw", email: "user@naver.com", imapHost: "imap.naver.com", smtpHost: "smtp.naver.com" };
    await writeEmailImapCredential(io(), emailImap);
    expect(await readEmailImapCredential(io())).toEqual(emailImap);
  });
});
