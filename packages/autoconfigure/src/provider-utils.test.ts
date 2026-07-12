import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { encryptCredentialEnvelope } from "@muse/shared";

import { clampPositive, readCredentialsSync, stringField } from "./provider-utils.js";

describe("readCredentialsSync", () => {
  it("returns the providers map from a well-formed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const f = join(dir, "creds.json");
    writeFileSync(f, JSON.stringify({ providers: { telegram: { token: "abc" } } }), "utf8");
    expect(readCredentialsSync(f)).toEqual({ telegram: { token: "abc" } });
  });
  it("returns {} when the file is missing", () => {
    expect(readCredentialsSync("/nonexistent/path/creds.json")).toEqual({});
  });
  it("returns {} when the file has invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const f = join(dir, "creds.json");
    writeFileSync(f, "{not json", "utf8");
    expect(readCredentialsSync(f)).toEqual({});
  });
  it("returns {} when providers field is missing or wrong shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const f = join(dir, "creds.json");
    writeFileSync(f, JSON.stringify({ not_providers: {} }), "utf8");
    expect(readCredentialsSync(f)).toEqual({});
    writeFileSync(f, JSON.stringify({ providers: "wrong-type" }), "utf8");
    expect(readCredentialsSync(f)).toEqual({});
  });

  it("transparently decrypts an encrypted envelope (format-preserving, security finding #4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const f = join(dir, "creds.json");
    const env = { MUSE_MEMORY_KEY: "test-key" };
    const plaintext = JSON.stringify({ providers: { openai: { token: "sk-secret" } } });
    writeFileSync(f, JSON.stringify(encryptCredentialEnvelope(plaintext, env)), "utf8");

    const raw = readCredentialsSync(f, env);
    expect(raw).toEqual({ openai: { token: "sk-secret" } });
  });

  it("a wrong key on an encrypted file THROWS (fail-closed) rather than returning {} (which would look like 'no credentials')", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const f = join(dir, "creds.json");
    const plaintext = JSON.stringify({ providers: { openai: { token: "sk-secret" } } });
    writeFileSync(f, JSON.stringify(encryptCredentialEnvelope(plaintext, { MUSE_MEMORY_KEY: "right-key" })), "utf8");

    expect(() => readCredentialsSync(f, { MUSE_MEMORY_KEY: "wrong-key" })).toThrow();
  });
});

describe("stringField", () => {
  it("returns the string when the field is non-empty", () => {
    expect(stringField({ token: "abc" }, "token")).toBe("abc");
  });
  it("returns undefined for missing keys / empty strings / non-strings / undefined record", () => {
    expect(stringField({ token: "" }, "token")).toBeUndefined();
    expect(stringField({ token: 42 }, "token")).toBeUndefined();
    expect(stringField({}, "token")).toBeUndefined();
    expect(stringField(undefined, "token")).toBeUndefined();
  });
  it("treats a whitespace-only value as absent, not a broken credential", () => {
    expect(stringField({ token: "   " }, "token")).toBeUndefined();
    expect(stringField({ token: "\t\n " }, "token")).toBeUndefined();
  });
  it("trims surrounding whitespace off a real value", () => {
    expect(stringField({ token: "  ghp_abc123  " }, "token")).toBe("ghp_abc123");
  });
});

describe("clampPositive (env-numeric context-window guard)", () => {
  it("returns the fallback when the env var is unset", () => {
    expect(clampPositive(undefined, 20)).toBe(20);
    expect(clampPositive("not a number", 10)).toBe(10);
  });

  it("returns a valid positive integer (whitespace-trimmed)", () => {
    expect(clampPositive("12", 20)).toBe(12);
    expect(clampPositive("42", 10)).toBe(42);
    expect(clampPositive("  7  ", 20)).toBe(7);
  });

  it("falls back for non-positive values", () => {
    expect(clampPositive("0", 20)).toBe(20);
    expect(clampPositive("-5", 20)).toBe(20);
  });

  it("falls back for non-numeric / empty / whitespace (env misconfig)", () => {
    expect(clampPositive("abc", 20)).toBe(20);
    expect(clampPositive("", 20)).toBe(20);
    expect(clampPositive("   ", 20)).toBe(20);
  });

  it("uses base-10 parseInt semantics (pins behaviour vs a future Number() refactor)", () => {
    expect(clampPositive("12.9", 20)).toBe(12);   // truncated, not 13
    expect(clampPositive("12abc", 20)).toBe(12);  // lenient prefix parse
    expect(clampPositive("1e3", 20)).toBe(1);     // NOT 1000 (parseInt stops at 'e')
    expect(clampPositive("0x10", 20)).toBe(20);   // base-10 → "0" → ≤0 → fallback, NOT 16
  });
});
