import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeGmailCredential } from "./credential-store.js";
import { emailAuthCheck } from "./commands-doctor-email.js";
import type { ProgramIO } from "./program.js";

describe("emailAuthCheck — muse doctor's Gmail auth probe (never mutates the credential store — that's the runtime token source's job)", () => {
  let workdir: string;
  const makeIo = (): ProgramIO => ({ configDir: workdir, stderr: () => undefined, stdout: () => undefined });

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-doctor-email-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("ok, 'not connected' when neither MUSE_GMAIL_TOKEN nor a stored credential exist", async () => {
    const result = await emailAuthCheck(makeIo(), {});
    expect(result).toEqual({ detail: expect.stringContaining("not connected"), name: "email-auth", status: "ok" });
  });

  it("ok, notes the raw-token path (no refresh to probe) when only MUSE_GMAIL_TOKEN is set", async () => {
    const result = await emailAuthCheck(makeIo(), { MUSE_GMAIL_TOKEN: "raw-token" });
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("MUSE_GMAIL_TOKEN");
    expect(result.detail).toContain("not affected by MUSE_LOCAL_ONLY");
  });

  it("ok, 'refresh verified' when the stored credential's refresh call succeeds (live probe, but NEVER writes back — doctor is read-only)", async () => {
    const io = makeIo();
    await writeGmailCredential(io, { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" });
    const fetchImpl = (async () => new Response(JSON.stringify({ access_token: "at-new", expires_in: 3600 }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const result = await emailAuthCheck(io, {}, fetchImpl);
    expect(result).toEqual({ detail: expect.stringContaining("refresh verified"), name: "email-auth", status: "ok" });
  });

  it("fail when the stored refresh token is already marked invalid — never re-probes the network for a known-dead token", async () => {
    const io = makeIo();
    await writeGmailCredential(io, { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1", refreshTokenInvalid: true });
    let fetchCalls = 0;
    const fetchImpl = (async () => { fetchCalls += 1; throw new Error("must not be called"); }) as unknown as typeof globalThis.fetch;
    const result = await emailAuthCheck(io, {}, fetchImpl);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("muse setup email");
    expect(fetchCalls).toBe(0);
  });

  it("fail when a live refresh returns invalid_grant — and the credential store is left UNTOUCHED (doctor is read-only)", async () => {
    const io = makeIo();
    await writeGmailCredential(io, { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" });
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof globalThis.fetch;
    const result = await emailAuthCheck(io, {}, fetchImpl);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("muse setup email");
    const { readGmailCredential } = await import("./credential-store.js");
    expect(await readGmailCredential(io)).toEqual({ clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" });
  });

  it("warn (not fail) on a transient network/5xx failure — a blip shouldn't read as 'broken, re-authorize'", async () => {
    const io = makeIo();
    await writeGmailCredential(io, { clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" });
    const fetchImpl = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
    const result = await emailAuthCheck(io, {}, fetchImpl);
    expect(result.status).toBe("warn");
  });
});
