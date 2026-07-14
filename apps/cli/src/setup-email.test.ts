import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthCallbackServer } from "@muse/mcp";

import { readGmailCredential } from "./credential-store.js";
import { runEmailSetup, runGmailOAuthLoopback, type SetupEmailIO } from "./setup-email.js";

function captureIo(overrides: Partial<SetupEmailIO> = {}): { readonly io: SetupEmailIO; readonly lines: string[] } {
  const lines: string[] = [];
  const io: SetupEmailIO = {
    stderr: (m) => lines.push(m),
    stdout: (m) => lines.push(m),
    ...overrides
  };
  return { io, lines };
}

/** A fake `startOAuthCallbackServer` that resolves/rejects `waitForCode()` deterministically, with a `state.closed` flag so tests can assert the server is ALWAYS released. */
function fakeCallbackServer(outcome: { readonly code?: string } | { readonly rejectWith: Error }): { readonly start: () => Promise<OAuthCallbackServer>; readonly state: { closed: boolean } } {
  const state = { closed: false };
  const start = async (): Promise<OAuthCallbackServer> => ({
    close: async () => { state.closed = true; },
    port: 54321,
    waitForCode: () => ("rejectWith" in outcome ? Promise.reject(outcome.rejectWith) : Promise.resolve({ code: outcome.code! }))
  });
  return { start, state };
}

describe("runGmailOAuthLoopback — the non-interactive PKCE/state/callback/exchange dance (never a real network call)", () => {
  it("happy path: opens the auth URL with the right params, exchanges the code, returns the credential, and always closes the callback server", async () => {
    const openedUrls: string[] = [];
    const server = fakeCallbackServer({ code: "auth-code-1" });
    const exchangeCalls: Array<{ readonly code: string; readonly codeVerifier: string; readonly redirectUri: string }> = [];
    const result = await runGmailOAuthLoopback({
      clientId: "cid-value",
      clientSecret: "csecret-value",
      exchangeCode: async (params) => {
        exchangeCalls.push({ code: params.code, codeVerifier: params.codeVerifier, redirectUri: params.redirectUri });
        return { accessToken: "at-1", expiresAt: 999, refreshToken: "rt-1" };
      },
      now: () => 0,
      openBrowser: (url) => { openedUrls.push(url); },
      startCallbackServer: server.start,
      stdout: () => undefined
    });

    expect(result).toEqual({ credential: { accessToken: "at-1", accessTokenExpiresAt: 999, clientId: "cid-value", clientSecret: "csecret-value", refreshToken: "rt-1" }, ok: true });
    expect(openedUrls).toHaveLength(1);
    const url = new URL(openedUrls[0]!);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid-value");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(exchangeCalls[0]!.redirectUri).toBe("http://127.0.0.1:54321/callback");
    expect(exchangeCalls[0]!.code).toBe("auth-code-1");
  });

  it("state mismatch / timeout / missing code (all surfaced by the callback server as a rejection) → ok:false, exchangeCode is NEVER called", async () => {
    const server = fakeCallbackServer({ rejectWith: new Error("OAuth state mismatch: the callback did not carry the expected CSRF state") });
    let exchangeCalled = false;
    const result = await runGmailOAuthLoopback({
      clientId: "cid",
      clientSecret: "csecret",
      exchangeCode: async () => { exchangeCalled = true; return { accessToken: "x", expiresAt: 0, refreshToken: "y" }; },
      startCallbackServer: server.start,
      stdout: () => undefined
    });
    expect(result).toEqual({ ok: false, reason: "OAuth state mismatch: the callback did not carry the expected CSRF state" });
    expect(exchangeCalled).toBe(false);
  });

  it("a loopback timeout surfaces the same way — ok:false, nothing exchanged", async () => {
    const server = fakeCallbackServer({ rejectWith: new Error("OAuth callback timed out after 300000ms") });
    const result = await runGmailOAuthLoopback({
      clientId: "cid", clientSecret: "csecret", startCallbackServer: server.start, stdout: () => undefined
    });
    expect(result).toEqual({ ok: false, reason: "OAuth callback timed out after 300000ms" });
  });

  it("a code-exchange failure surfaces as ok:false with the exchange error's message", async () => {
    const server = fakeCallbackServer({ code: "auth-code-1" });
    const result = await runGmailOAuthLoopback({
      clientId: "cid",
      clientSecret: "csecret",
      exchangeCode: async () => { throw new Error("Gmail token exchange failed (400: invalid_grant)"); },
      startCallbackServer: server.start,
      stdout: () => undefined
    });
    expect(result).toEqual({ ok: false, reason: "Gmail token exchange failed (400: invalid_grant)" });
  });

  it("closes the callback server on every path — success, callback rejection, AND exchange failure", async () => {
    const happy = fakeCallbackServer({ code: "c" });
    await runGmailOAuthLoopback({
      clientId: "cid", clientSecret: "csecret",
      exchangeCode: async () => ({ accessToken: "at", expiresAt: 0, refreshToken: "rt" }),
      startCallbackServer: happy.start, stdout: () => undefined
    });
    expect(happy.state.closed).toBe(true);

    const rejected = fakeCallbackServer({ rejectWith: new Error("boom") });
    await runGmailOAuthLoopback({ clientId: "cid", clientSecret: "csecret", startCallbackServer: rejected.start, stdout: () => undefined });
    expect(rejected.state.closed).toBe(true);

    const exchangeFails = fakeCallbackServer({ code: "c" });
    await runGmailOAuthLoopback({
      clientId: "cid", clientSecret: "csecret",
      exchangeCode: async () => { throw new Error("exchange also fails"); },
      startCallbackServer: exchangeFails.start, stdout: () => undefined
    });
    expect(exchangeFails.state.closed).toBe(true);
  });

  it("never leaks the client secret into a failure reason (redaction floor, AC4)", async () => {
    const secretMarker = "SECRET-MARKER-should-never-leak";
    const server = fakeCallbackServer({ rejectWith: new Error("OAuth state mismatch") });
    const result = await runGmailOAuthLoopback({
      clientId: "cid", clientSecret: secretMarker, startCallbackServer: server.start, stdout: () => undefined
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });
});

describe("runEmailSetup — the full wizard (clack prompts injected, never real stdin/network)", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-setup-email-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("cancelling at the Client ID prompt stores NOTHING and returns ok:false", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, { promptClientId: async () => undefined });
    expect(result.ok).toBe(false);
    expect(lines.join("")).toContain("cancelled");
    expect(await readGmailCredential(io)).toBeUndefined();
  });

  it("cancelling at the Client Secret prompt stores NOTHING and returns ok:false", async () => {
    const { io } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      promptClientId: async () => "cid",
      promptClientSecret: async () => undefined
    });
    expect(result.ok).toBe(false);
    expect(await readGmailCredential(io)).toBeUndefined();
  });

  it("runs regardless of MUSE_LOCAL_ONLY — Gmail is the user's own data plane, not an LLM call, so (unlike setup-calendar/setup-messaging) this wizard is deliberately NOT gated on local-only", async () => {
    const { io } = captureIo({ configDir: workdir, env: { MUSE_LOCAL_ONLY: "true" } });
    const server = fakeCallbackServer({ code: "auth-code-1" });
    const result = await runEmailSetup(io, {
      exchangeCode: async () => ({ accessToken: "at-1", expiresAt: Date.now() + 3600_000, refreshToken: "rt-1" }),
      promptClientId: async () => "cid",
      promptClientSecret: async () => "csecret",
      startCallbackServer: server.start,
      verifyProfile: async () => "user@example.com"
    });
    expect(result.ok).toBe(true);
    expect(await readGmailCredential(io)).toBeDefined();
  });

  it("a failed loopback (state mismatch / timeout / exchange failure) stores NOTHING, returns ok:false, and reports a non-empty stderr line", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const server = fakeCallbackServer({ rejectWith: new Error("OAuth state mismatch: the callback did not carry the expected CSRF state") });
    const result = await runEmailSetup(io, {
      promptClientId: async () => "cid",
      promptClientSecret: async () => "csecret",
      startCallbackServer: server.start
    });
    expect(result.ok).toBe(false);
    expect(lines.some((line) => line.includes("authorization failed"))).toBe(true);
    expect(await readGmailCredential(io)).toBeUndefined();
  });

  it("happy path: persists the credential (chmod 600), and reports the verified email address", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const server = fakeCallbackServer({ code: "auth-code-1" });
    const result = await runEmailSetup(io, {
      exchangeCode: async () => ({ accessToken: "at-1", expiresAt: Date.now() + 3600_000, refreshToken: "rt-1" }),
      promptClientId: async () => "cid",
      promptClientSecret: async () => "csecret",
      startCallbackServer: server.start,
      verifyProfile: async (accessToken) => (accessToken === "at-1" ? "user@example.com" : undefined)
    });
    expect(result.ok).toBe(true);
    const stored = await readGmailCredential(io);
    expect(stored).toEqual({ accessToken: "at-1", accessTokenExpiresAt: expect.any(Number), clientId: "cid", clientSecret: "csecret", refreshToken: "rt-1" });
    expect(lines.some((line) => line.includes("connected as user@example.com"))).toBe(true);
    const fileStat = await stat(path.join(workdir, "credentials.json"));
    expect((fileStat.mode & 0o777).toString(8)).toBe("600");
  });

  it("happy path but the live verify probe fails: the credential is STILL saved (OAuth itself succeeded), with a soft warning instead of a crash", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const server = fakeCallbackServer({ code: "auth-code-1" });
    const result = await runEmailSetup(io, {
      exchangeCode: async () => ({ accessToken: "at-1", expiresAt: Date.now() + 3600_000, refreshToken: "rt-1" }),
      promptClientId: async () => "cid",
      promptClientSecret: async () => "csecret",
      startCallbackServer: server.start,
      verifyProfile: async () => undefined
    });
    expect(result.ok).toBe(true);
    expect(await readGmailCredential(io)).toBeDefined();
    expect(lines.some((line) => line.includes("couldn't verify"))).toBe(true);
  });

  it("never prints the client secret to stdout/stderr across the cancelled, failed, or successful paths", async () => {
    const secretMarker = "SECRET-MARKER-should-never-leak";
    const paths: Array<() => Promise<unknown>> = [
      async () => {
        const { io, lines } = captureIo({ configDir: workdir });
        const server = fakeCallbackServer({ rejectWith: new Error("boom") });
        await runEmailSetup(io, { promptClientId: async () => "cid", promptClientSecret: async () => secretMarker, startCallbackServer: server.start });
        return lines;
      },
      async () => {
        const { io, lines } = captureIo({ configDir: workdir });
        const server = fakeCallbackServer({ code: "c" });
        await runEmailSetup(io, {
          exchangeCode: async () => ({ accessToken: "at", expiresAt: Date.now() + 1000, refreshToken: "rt" }),
          promptClientId: async () => "cid",
          promptClientSecret: async () => secretMarker,
          startCallbackServer: server.start,
          verifyProfile: async () => "user@example.com"
        });
        return lines;
      }
    ];
    for (const run of paths) {
      const lines = await run() as string[];
      expect(lines.join("")).not.toContain(secretMarker);
    }
  });
});
