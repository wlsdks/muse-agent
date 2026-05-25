import { describe, expect, it } from "vitest";

import { decryptExportBuffer, encryptExportBuffer, isEncryptedExportBuffer } from "./export-crypto.js";

const PLAIN = Buffer.from("personal export: tasks, notes, secrets");
const PASS = "correct horse battery staple";

describe("export-crypto — AES-256-GCM passphrase round-trip", () => {
  it("encrypt → decrypt with the right passphrase returns the original bytes", () => {
    const blob = encryptExportBuffer(PLAIN, PASS);
    expect(decryptExportBuffer(blob, PASS).equals(PLAIN)).toBe(true);
  });

  it("produces a recognisable encrypted blob (magic header) distinct from plaintext", () => {
    const blob = encryptExportBuffer(PLAIN, PASS);
    expect(isEncryptedExportBuffer(blob)).toBe(true);
    expect(isEncryptedExportBuffer(PLAIN)).toBe(false);
    expect(blob.equals(PLAIN)).toBe(false);
  });

  it("uses a fresh salt+iv each time — same input encrypts to different bytes", () => {
    expect(encryptExportBuffer(PLAIN, PASS).equals(encryptExportBuffer(PLAIN, PASS))).toBe(false);
  });

  it("rejects an empty passphrase on encrypt", () => {
    expect(() => encryptExportBuffer(PLAIN, "")).toThrow(/passphrase/i);
  });

  it("fails to decrypt with the wrong passphrase (GCM auth)", () => {
    const blob = encryptExportBuffer(PLAIN, PASS);
    expect(() => decryptExportBuffer(blob, "wrong pass")).toThrow();
  });

  it("fails to decrypt a tampered blob (auth tag mismatch)", () => {
    const blob = encryptExportBuffer(PLAIN, PASS);
    const tampered = Buffer.from(blob);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last]! ^ 0xff) & 0xff; // flip a bit in the auth tag
    expect(() => decryptExportBuffer(tampered, PASS)).toThrow();
  });
});
