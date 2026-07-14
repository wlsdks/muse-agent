import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearOAuth,
  loadClientInformation,
  loadCodeVerifier,
  loadOAuthRecord,
  loadState,
  loadTokens,
  oauthRecordPath,
  saveClientInformation,
  saveCodeVerifier,
  saveState,
  saveTokens
} from "../src/oauth-store.js";

const SERVER = "github-remote";
const TOKENS: OAuthTokens = { access_token: "at-123", refresh_token: "rt-456", token_type: "Bearer" };
const CLIENT: OAuthClientInformationFull = {
  client_id: "dcr-client-1",
  redirect_uris: ["http://127.0.0.1:33418/callback"]
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-oauth-store-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("oauth-store round-trips", () => {
  it("returns an empty record when nothing is saved", async () => {
    expect(await loadOAuthRecord(dir, SERVER)).toEqual({});
    expect(await loadTokens(dir, SERVER)).toBeUndefined();
  });

  it("round-trips each field independently", async () => {
    await saveTokens(dir, SERVER, TOKENS);
    await saveClientInformation(dir, SERVER, CLIENT);
    await saveCodeVerifier(dir, SERVER, "verifier-abc");
    await saveState(dir, SERVER, "state-xyz");

    expect(await loadTokens(dir, SERVER)).toEqual(TOKENS);
    expect(await loadClientInformation(dir, SERVER)).toEqual(CLIENT);
    expect(await loadCodeVerifier(dir, SERVER)).toBe("verifier-abc");
    expect(await loadState(dir, SERVER)).toBe("state-xyz");
  });

  it("keeps servers isolated (no cross-talk)", async () => {
    await saveTokens(dir, "alpha", { access_token: "a", token_type: "Bearer" });
    await saveTokens(dir, "beta", { access_token: "b", token_type: "Bearer" });
    expect((await loadTokens(dir, "alpha"))?.access_token).toBe("a");
    expect((await loadTokens(dir, "beta"))?.access_token).toBe("b");
  });

  it("writes the record file with 0600 permissions", async () => {
    await saveTokens(dir, SERVER, TOKENS);
    const mode = statSync(oauthRecordPath(dir, SERVER)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("sanitizes a path-traversal serverId into a contained filename", () => {
    const p = oauthRecordPath(dir, "../../etc/passwd");
    // The file must sit DIRECTLY inside dir — no separator lets it escape.
    expect(dirname(p)).toBe(dir);
  });
});

describe("oauth-store clearOAuth scopes", () => {
  beforeEach(async () => {
    await saveTokens(dir, SERVER, TOKENS);
    await saveClientInformation(dir, SERVER, CLIENT);
    await saveCodeVerifier(dir, SERVER, "verifier-abc");
  });

  it("scope 'tokens' clears only tokens", async () => {
    await clearOAuth(dir, SERVER, "tokens");
    expect(await loadTokens(dir, SERVER)).toBeUndefined();
    expect(await loadClientInformation(dir, SERVER)).toEqual(CLIENT);
    expect(await loadCodeVerifier(dir, SERVER)).toBe("verifier-abc");
  });

  it("scope 'client' clears only client info", async () => {
    await clearOAuth(dir, SERVER, "client");
    expect(await loadClientInformation(dir, SERVER)).toBeUndefined();
    expect(await loadTokens(dir, SERVER)).toEqual(TOKENS);
  });

  it("scope 'verifier' clears only the code verifier", async () => {
    await clearOAuth(dir, SERVER, "verifier");
    expect(await loadCodeVerifier(dir, SERVER)).toBeUndefined();
    expect(await loadTokens(dir, SERVER)).toEqual(TOKENS);
  });

  it("scope 'all' removes the whole record", async () => {
    await clearOAuth(dir, SERVER, "all");
    expect(await loadOAuthRecord(dir, SERVER)).toEqual({});
  });
});

describe("oauth-store corruption handling", () => {
  it("treats a corrupt file as empty and quarantines it (no throw)", async () => {
    writeFileSync(oauthRecordPath(dir, SERVER), "{ this is not json", { mode: 0o600 });
    expect(await loadOAuthRecord(dir, SERVER)).toEqual({});
    // A subsequent write succeeds on the fresh file.
    await saveTokens(dir, SERVER, TOKENS);
    expect(await loadTokens(dir, SERVER)).toEqual(TOKENS);
  });
});

describe("oauth-store encryption at rest", () => {
  const encEnv: NodeJS.ProcessEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "test-key-abcdef" };

  it("writes ciphertext (no plaintext token on disk) yet round-trips", async () => {
    await saveTokens(dir, SERVER, TOKENS, encEnv);
    const onDisk = readFileSync(oauthRecordPath(dir, SERVER), "utf8");
    expect(onDisk).not.toContain("at-123");
    expect(onDisk).not.toContain("rt-456");
    expect(onDisk).toContain("aes-256-gcm");
    expect(await loadTokens(dir, SERVER, encEnv)).toEqual(TOKENS);
  });

  it("throws fail-closed on a wrong key rather than discarding the token", async () => {
    await saveTokens(dir, SERVER, TOKENS, encEnv);
    const wrongKey: NodeJS.ProcessEnv = { MUSE_CREDENTIALS_ENCRYPT: "true", MUSE_MEMORY_KEY: "different-key" };
    await expect(loadOAuthRecord(dir, SERVER, wrongKey)).rejects.toThrow(/decrypt/i);
  });
});
