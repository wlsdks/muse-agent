import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveDefaultModel } from "@muse/autoconfigure";
import { isEncryptedCredentialEnvelope } from "@muse/shared";

import { persistModelProviderKey, SETUP_MODEL_PROVIDER_SPECS } from "./setup-model.js";

describe("SETUP_MODEL_PROVIDER_SPECS", () => {
  it("covers the same provider ids autoconfigure recognises", () => {
    const ids = SETUP_MODEL_PROVIDER_SPECS.map((spec) => spec.id).sort();
    expect(ids).toEqual([
      "anthropic",
      "cerebras",
      "deepseek",
      "gemini",
      "groq",
      "mistral",
      "moonshot",
      "ollama",
      "openai",
      "openrouter",
      "together"
    ]);
  });

  it("maps each provider to the exact env key the autoconfigure layer probes", () => {
    const byId: Record<string, string> = {};
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      byId[spec.id] = spec.envKey;
    }
    expect(byId).toEqual({
      anthropic: "ANTHROPIC_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      gemini: "GEMINI_API_KEY",
      groq: "GROQ_API_KEY",
      mistral: "MISTRAL_API_KEY",
      moonshot: "MOONSHOT_API_KEY",
      ollama: "OLLAMA_BASE_URL",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      together: "TOGETHER_API_KEY"
    });
  });

  it("every spec has a non-empty docs URL and suggested model spec", () => {
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      expect(spec.docs).toMatch(/^https?:\/\//);
      expect(spec.suggestedModel).toMatch(/\//);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it("placeholderHint is descriptive (not just '...') so wizard prompts guide the user", () => {
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      const trimmed = spec.placeholderHint.replace(/\./g, "").trim();
      expect(trimmed.length, `${spec.id} placeholderHint is too uninformative: ${JSON.stringify(spec.placeholderHint)}`).toBeGreaterThan(0);
    }
  });

  it("ollama is the only non-secret entry (env carries a base URL, not a token)", () => {
    const nonSecret = SETUP_MODEL_PROVIDER_SPECS.filter((spec) => !spec.secret).map((spec) => spec.id);
    expect(nonSecret).toEqual(["ollama"]);
  });

  it("every spec.suggestedModel matches what resolveDefaultModel picks when only that provider's env key is set", () => {
    for (const spec of SETUP_MODEL_PROVIDER_SPECS) {
      // Cloud-credential inference is gated behind the local-only opt-out;
      // local-first ignores ambient cloud keys by default.
      const env: Record<string, string> = { MUSE_LOCAL_ONLY: "false", [spec.envKey]: "test-token" };
      const inferred = resolveDefaultModel(env);
      expect(inferred, `${spec.id} default-model contract drift`).toBe(spec.suggestedModel);
    }
  });
});

// Behavioral coverage for encryption-at-rest (security finding #4): provider
// API keys are the highest-value credential — the store must be unreadable
// ciphertext on disk when MUSE_CREDENTIALS_ENCRYPT is on, a wrong-key read
// must fail CLOSED, and an existing user's plaintext models.json must keep
// working untouched (no key/flag → plaintext, exactly as before).
describe("persistModelProviderKey encryption-at-rest", () => {
  let home: string;
  let file: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "muse-models-"));
    file = join(home, ".muse", "models.json");
  });

  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  it("plaintext default: with no key/flag, writes plaintext exactly as before (backward compatible)", async () => {
    await persistModelProviderKey(home, "openai", "sk-plain-token", "openai/gpt-4o-mini", {});
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("sk-plain-token");
    expect(isEncryptedCredentialEnvelope(JSON.parse(raw) as unknown)).toBe(false);
  });

  it("legacy plaintext read still works when encryption is later enabled (format-preserving)", async () => {
    await persistModelProviderKey(home, "openai", "sk-legacy-token", "openai/gpt-4o-mini", {});
    // A subsequent write under encryption must be able to read the existing
    // plaintext keys back before re-persisting (merge, not clobber).
    await persistModelProviderKey(home, "anthropic", "sk-ant-new", "anthropic/claude-haiku-4-5-20251001", {
      MUSE_CREDENTIALS_ENCRYPT: "true",
      MUSE_MEMORY_KEY: "k"
    });
    const raw = await readFile(file, "utf8");
    const envelope = JSON.parse(raw) as unknown;
    expect(isEncryptedCredentialEnvelope(envelope)).toBe(true);
  });

  it("round-trip: on-disk bytes are ciphertext with no plaintext token, and read-back decrypts identically", async () => {
    const env = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "test-key" };
    await persistModelProviderKey(home, "openai", "sk-super-secret", "openai/gpt-4o-mini", env);

    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("sk-super-secret");
    expect(isEncryptedCredentialEnvelope(JSON.parse(raw) as unknown)).toBe(true);

    // A second write under the same key must read back the first key intact.
    await persistModelProviderKey(home, "anthropic", "sk-ant-secret", "anthropic/claude-haiku-4-5-20251001", env);
    const finalRaw = await readFile(file, "utf8");
    expect(finalRaw).not.toContain("sk-super-secret");
    expect(finalRaw).not.toContain("sk-ant-secret");
  });

  it("wrong-key read fails CLOSED: throws and leaves the ciphertext on disk unchanged", async () => {
    const rightEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "right-key" };
    await persistModelProviderKey(home, "openai", "sk-secret", "openai/gpt-4o-mini", rightEnv);

    const before = await readFile(file, "utf8");
    expect(isEncryptedCredentialEnvelope(JSON.parse(before) as unknown)).toBe(true);

    const wrongEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "wrong-key" };
    await expect(
      persistModelProviderKey(home, "anthropic", "sk-ant", "anthropic/claude-haiku-4-5-20251001", wrongEnv)
    ).rejects.toThrow();

    const after = await readFile(file, "utf8");
    expect(after).toBe(before);
  });

  it("format-preserving: once encrypted, stays encrypted even if the flag is later unset", async () => {
    const encEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "k" };
    await persistModelProviderKey(home, "openai", "sk-a", "openai/gpt-4o-mini", encEnv);
    expect(isEncryptedCredentialEnvelope(JSON.parse(await readFile(file, "utf8")) as unknown)).toBe(true);

    // flag unset, key still supplied — a later write must NOT silently decrypt at rest
    await persistModelProviderKey(home, "anthropic", "sk-b", "anthropic/claude-haiku-4-5-20251001", { MUSE_MEMORY_KEY: "k" });
    expect(isEncryptedCredentialEnvelope(JSON.parse(await readFile(file, "utf8")) as unknown)).toBe(true);
  });

  it("backs up the pre-encryption plaintext on the FIRST transition, readable without the key", async () => {
    await persistModelProviderKey(home, "openai", "sk-before-encrypt", "openai/gpt-4o-mini", {});
    await persistModelProviderKey(home, "anthropic", "sk-ant", "anthropic/claude-haiku-4-5-20251001", {
      MUSE_CREDENTIALS_ENCRYPT: "true",
      MUSE_MEMORY_KEY: "k"
    });

    const entries = await readdir(join(home, ".muse"));
    const backups = entries.filter((e) => e.includes(".plaintext-backup-"));
    expect(backups).toHaveLength(1);
    const backupRaw = await readFile(join(home, ".muse", backups[0]!), "utf8");
    expect(backupRaw).toContain("sk-before-encrypt");
    expect(isEncryptedCredentialEnvelope(JSON.parse(backupRaw) as unknown)).toBe(false);
  });

  it("does NOT back up when the store is created encrypted from the start (nothing to lose)", async () => {
    await persistModelProviderKey(home, "openai", "sk-fresh", "openai/gpt-4o-mini", {
      MUSE_CREDENTIALS_ENCRYPT: "true",
      MUSE_MEMORY_KEY: "k"
    });
    const entries = await readdir(join(home, ".muse"));
    expect(entries.filter((e) => e.includes(".plaintext-backup-"))).toEqual([]);
  });
});
