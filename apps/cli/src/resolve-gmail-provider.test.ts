import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ImapSmtpEmailProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeEmailImapCredential, writeGmailCredential } from "./credential-store.js";
import type { ProgramIO } from "./program.js";
import { isGmailConfigured, resolveGmailProvider } from "./resolve-gmail-provider.js";

function bearerCapturingFetch(): { readonly fetchImpl: typeof globalThis.fetch; readonly captured: { bearer: string | undefined } } {
  const captured: { bearer: string | undefined } = { bearer: undefined };
  const fetchImpl = (async (_url: string | URL, init?: { readonly headers?: Record<string, string> }) => {
    captured.bearer = init?.headers?.authorization;
    return new Response(JSON.stringify({ messages: [] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { captured, fetchImpl };
}

describe("resolveGmailProvider / isGmailConfigured", () => {
  let workdir: string;
  const makeIo = (): ProgramIO => ({
    // A configDir that never exists — proves the env-token path NEVER
    // touches the credential store at all.
    configDir: path.join(tmpdir(), "muse-resolve-gmail-nonexistent"),
    stderr: () => undefined,
    stdout: () => undefined
  });

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-resolve-gmail-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("returns undefined and reports unconfigured when NEITHER env token nor a stored credential exists", () => {
    const io = makeIo();
    expect(resolveGmailProvider({ env: {}, io })).toBeUndefined();
    expect(isGmailConfigured(io, {})).toBe(false);
  });

  it("MUSE_GMAIL_TOKEN wins: the resolved provider's requests carry the raw env token as Bearer, without ever reading the credential store", async () => {
    const io = makeIo();
    const { captured, fetchImpl } = bearerCapturingFetch();
    const provider = resolveGmailProvider({ env: { MUSE_GMAIL_TOKEN: "  raw-env-token  " }, fetchImpl, io });
    expect(provider).toBeDefined();
    await provider!.listRecent(5);
    expect(captured.bearer).toBe("Bearer raw-env-token");
    expect(isGmailConfigured(io, { MUSE_GMAIL_TOKEN: "raw-env-token" })).toBe(true);
  });

  it("falls back to the stored OAuth credential (via the refreshing token source) when no env token is set", async () => {
    const io: ProgramIO = { configDir: workdir, stderr: () => undefined, stdout: () => undefined };
    await writeGmailCredential(io, {
      accessToken: "stored-cached-at",
      accessTokenExpiresAt: Date.now() + 10 * 60_000,
      clientId: "cid",
      clientSecret: "csecret",
      refreshToken: "rt-1"
    });
    const { captured, fetchImpl } = bearerCapturingFetch();
    const provider = resolveGmailProvider({ env: {}, fetchImpl, io });
    expect(provider).toBeDefined();
    await provider!.listRecent(5);
    expect(captured.bearer).toBe("Bearer stored-cached-at");
    expect(isGmailConfigured(io, {})).toBe(true);
  });

  it("reports unconfigured (and resolveGmailProvider returns undefined) once the stored refresh token is marked invalid", async () => {
    const io: ProgramIO = { configDir: workdir, stderr: () => undefined, stdout: () => undefined };
    await writeGmailCredential(io, {
      clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1", refreshTokenInvalid: true
    });
    expect(isGmailConfigured(io, {})).toBe(false);
    expect(resolveGmailProvider({ env: {}, io })).toBeUndefined();
  });

  it("falls back to the stored App Password (IMAP) credential when no env token and no OAuth record exist — precedence: env > oauth > imap", async () => {
    const io: ProgramIO = { configDir: workdir, stderr: () => undefined, stdout: () => undefined };
    await writeEmailImapCredential(io, { appPassword: "app-pass-1234567890abcd", email: "user@gmail.com" });
    expect(isGmailConfigured(io, {})).toBe(true);
    const provider = resolveGmailProvider({ env: {}, io });
    expect(provider).toBeInstanceOf(ImapSmtpEmailProvider);
    // No imapClientFactory is injected — a real ImapFlow would only be
    // constructed on first use, and the provider's own vitest guard
    // (never a real socket under vitest) proves this IS the real,
    // lazily-connecting IMAP provider, not a stub.
    await expect(provider!.listRecent(5)).rejects.toThrow(/imapClientFactory/);
  });

  it("an OAuth record wins over an App Password record when BOTH are stored", async () => {
    const io: ProgramIO = { configDir: workdir, stderr: () => undefined, stdout: () => undefined };
    await writeEmailImapCredential(io, { appPassword: "app-pass-1234567890abcd", email: "user@gmail.com" });
    await writeGmailCredential(io, {
      accessToken: "stored-cached-at",
      accessTokenExpiresAt: Date.now() + 10 * 60_000,
      clientId: "cid",
      clientSecret: "csecret",
      refreshToken: "rt-1"
    });
    const { captured, fetchImpl } = bearerCapturingFetch();
    const provider = resolveGmailProvider({ env: {}, fetchImpl, io });
    expect(provider).not.toBeInstanceOf(ImapSmtpEmailProvider);
    await provider!.listRecent(5);
    expect(captured.bearer).toBe("Bearer stored-cached-at");
  });

  it("MUSE_GMAIL_TOKEN wins over BOTH a stored OAuth record and a stored App Password record", async () => {
    const io: ProgramIO = { configDir: workdir, stderr: () => undefined, stdout: () => undefined };
    await writeEmailImapCredential(io, { appPassword: "app-pass-1234567890abcd", email: "user@gmail.com" });
    await writeGmailCredential(io, { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" });
    const { captured, fetchImpl } = bearerCapturingFetch();
    const provider = resolveGmailProvider({ env: { MUSE_GMAIL_TOKEN: "raw-env-token" }, fetchImpl, io });
    expect(provider).not.toBeInstanceOf(ImapSmtpEmailProvider);
    await provider!.listRecent(5);
    expect(captured.bearer).toBe("Bearer raw-env-token");
  });
});
