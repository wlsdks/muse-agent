import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthCallbackServer } from "@muse/mcp";

import { resetCliLanguageCache, setCliLanguage } from "./cli-i18n.js";
import { readEmailImapCredential, readGmailCredential } from "./credential-store.js";
import { buildGmailAppPasswordUrls, classifyEmailProvider, runAppPasswordEmailSetup, runEmailSetup, runGmailOAuthLoopback, type SetupEmailIO } from "./setup-email.js";

// Every wizard entrypoint (`runEmailSetup` / `runAppPasswordEmailSetup` /
// `runOAuthEmailSetup`) resolves its rendering language once via
// `resolveCliLanguage`, which caches per PROCESS. `resetCliLanguageCache`
// before each test forces a fresh resolution from THIS test's own
// `io.env` (defaulted to `MUSE_LANG: "en"` below) — deterministic on any
// dev/CI machine's OS locale, and lets the KO-rendering tests further down
// override it explicitly. `setCliLanguage("en")` is the same safety net
// for `runGmailOAuthLoopback`'s standalone tests, which call `t()`
// directly without ever going through a wizard entrypoint that resolves.
beforeEach(() => {
  resetCliLanguageCache();
  setCliLanguage("en");
});

function captureIo(overrides: Partial<SetupEmailIO> = {}): { readonly io: SetupEmailIO; readonly lines: string[] } {
  const lines: string[] = [];
  const io: SetupEmailIO = {
    stderr: (m) => lines.push(m),
    stdout: (m) => lines.push(m),
    ...overrides,
    env: { MUSE_LANG: "en", ...overrides.env }
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

describe("runEmailSetup — method selection", () => {
  it("cancelling the method prompt stores nothing and returns ok:false, without asking either wizard's questions", async () => {
    const { io, lines } = captureIo({ configDir: path.join(tmpdir(), "muse-setup-email-unused") });
    const result = await runEmailSetup(io, { promptMethod: async () => undefined });
    expect(result.ok).toBe(false);
    expect(lines.join("")).toContain("cancelled");
  });
});

describe("runEmailSetup — the OAuth wizard (choice 2, unchanged; clack prompts injected, never real stdin/network)", () => {
  let workdir: string;
  const oauth = { promptMethod: async () => "oauth" as const };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-setup-email-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("cancelling at the Client ID prompt stores NOTHING and returns ok:false", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, { ...oauth, promptClientId: async () => undefined });
    expect(result.ok).toBe(false);
    expect(lines.join("")).toContain("cancelled");
    expect(await readGmailCredential(io)).toBeUndefined();
  });

  it("cancelling at the Client Secret prompt stores NOTHING and returns ok:false", async () => {
    const { io } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...oauth,
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
      ...oauth,
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
      ...oauth,
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
      ...oauth,
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
      ...oauth,
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
        await runEmailSetup(io, { ...oauth, openBrowser: () => undefined, promptClientId: async () => "cid", promptClientSecret: async () => secretMarker, startCallbackServer: server.start });
        return lines;
      },
      async () => {
        const { io, lines } = captureIo({ configDir: workdir });
        const server = fakeCallbackServer({ code: "c" });
        await runEmailSetup(io, {
          ...oauth,
          exchangeCode: async () => ({ accessToken: "at", expiresAt: Date.now() + 1000, refreshToken: "rt" }),
          openBrowser: () => undefined,
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

describe("runEmailSetup — the App Password wizard (choice 1, recommended; prompts + verifier injected, never a real socket)", () => {
  let workdir: string;
  const apppassword = { promptMethod: async () => "apppassword" as const };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-setup-email-imap-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("cancelling at the email prompt stores NOTHING and returns ok:false", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, { ...apppassword, promptEmail: async () => undefined });
    expect(result.ok).toBe(false);
    expect(lines.join("")).toContain("cancelled");
    expect(await readEmailImapCredential(io)).toBeUndefined();
  });

  it("cancelling at the app-password prompt stores NOTHING and returns ok:false", async () => {
    const { io } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...apppassword,
      promptAppPassword: async () => undefined,
      promptEmail: async () => "user@gmail.com"
    });
    expect(result.ok).toBe(false);
    expect(await readEmailImapCredential(io)).toBeUndefined();
  });

  it("happy path (Gmail): verifies via IMAP login, stores the credential (chmod 600), reports the mailbox count, never asks for a host override", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    let hostPromptCalled = false;
    const result = await runEmailSetup(io, {
      ...apppassword,
      promptAppPassword: async () => "abcd efgh ijkl mnop",
      promptEmail: async () => "user@gmail.com",
      promptImapHost: async () => { hostPromptCalled = true; return undefined; },
      verifyImapConnection: async (config) => {
        expect(config).toEqual({ appPassword: "abcdefghijklmnop", email: "user@gmail.com" });
        return { messageCount: 12, ok: true };
      }
    });
    expect(result.ok).toBe(true);
    expect(hostPromptCalled).toBe(false);
    expect(await readEmailImapCredential(io)).toEqual({ appPassword: "abcdefghijklmnop", email: "user@gmail.com" });
    expect(lines.some((line) => line.includes("inbox has 12 message(s)"))).toBe(true);
    const fileStat = await stat(path.join(workdir, "credentials.json"));
    expect((fileStat.mode & 0o777).toString(8)).toBe("600");
  });

  it("happy path (non-Gmail): asks for IMAP/SMTP host overrides and stores them", async () => {
    const { io } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...apppassword,
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@naver.com",
      promptImapHost: async () => "imap.naver.com",
      promptSmtpHost: async () => "smtp.naver.com",
      verifyImapConnection: async () => ({ messageCount: 1, ok: true })
    });
    expect(result.ok).toBe(true);
    expect(await readEmailImapCredential(io)).toEqual({
      appPassword: "pw", email: "user@naver.com", imapHost: "imap.naver.com", smtpHost: "smtp.naver.com"
    });
  });

  it("a failed verification (wrong password / 2FA not enabled / network) stores NOTHING, returns ok:false, and reports the actionable error", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...apppassword,
      promptAppPassword: async () => "wrongpw",
      promptEmail: async () => "user@gmail.com",
      verifyImapConnection: async () => ({ error: new Error("IMAP login rejected for user@gmail.com — check the app password"), ok: false })
    });
    expect(result.ok).toBe(false);
    expect(lines.some((line) => line.includes("could not connect") && line.includes("check the app password"))).toBe(true);
    expect(await readEmailImapCredential(io)).toBeUndefined();
  });

  it("never prints the app password to stdout/stderr across the cancelled, failed, or successful paths", async () => {
    const secretMarker = "SECRET-MARKER-should-never-leak";
    const paths: Array<() => Promise<unknown>> = [
      async () => {
        const { io, lines } = captureIo({ configDir: workdir });
        await runEmailSetup(io, {
          ...apppassword,
          promptAppPassword: async () => secretMarker,
          promptEmail: async () => "user@gmail.com",
          verifyImapConnection: async () => ({ error: new Error("IMAP login rejected"), ok: false })
        });
        return lines;
      },
      async () => {
        const { io, lines } = captureIo({ configDir: workdir });
        await runEmailSetup(io, {
          ...apppassword,
          promptAppPassword: async () => secretMarker,
          promptEmail: async () => "user@gmail.com",
          verifyImapConnection: async () => ({ messageCount: 1, ok: true })
        });
        return lines;
      }
    ];
    for (const run of paths) {
      const lines = await run() as string[];
      expect(lines.join("")).not.toContain(secretMarker);
    }
  });

  it("browser-open is offered ONLY for a Gmail-family domain — never called for a Korean-webmail or generic domain", async () => {
    const gmailOffers: string[] = [];
    await runEmailSetup(io("gmail-offer"), {
      ...apppassword,
      confirmOpenBrowser: async (message) => { gmailOffers.push(message); return false; },
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@gmail.com",
      verifyImapConnection: async () => ({ messageCount: 0, ok: true })
    });
    expect(gmailOffers).toHaveLength(1);

    const naverOffers: string[] = [];
    await runEmailSetup(io("naver-offer"), {
      ...apppassword,
      confirmOpenBrowser: async (message) => { naverOffers.push(message); return false; },
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@naver.com",
      promptImapHost: async () => undefined,
      promptSmtpHost: async () => undefined,
      verifyImapConnection: async () => ({ messageCount: 0, ok: true })
    });
    expect(naverOffers).toHaveLength(0);

    const genericOffers: string[] = [];
    await runEmailSetup(io("generic-offer"), {
      ...apppassword,
      confirmOpenBrowser: async (message) => { genericOffers.push(message); return false; },
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@example.com",
      promptImapHost: async () => undefined,
      promptSmtpHost: async () => undefined,
      verifyImapConnection: async () => ({ messageCount: 0, ok: true })
    });
    expect(genericOffers).toHaveLength(0);

    function io(dir: string): SetupEmailIO {
      return captureIo({ configDir: path.join(workdir, dir) }).io;
    }
  });

  it("declining the open-browser offer still prints the account-pinned URL (the printed URL is the real fallback)", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...apppassword,
      confirmOpenBrowser: async () => false,
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@gmail.com",
      verifyImapConnection: async () => ({ messageCount: 0, ok: true })
    });
    expect(result.ok).toBe(true);
    const { appPasswordUrl } = buildGmailAppPasswordUrls("user@gmail.com");
    expect(lines.some((line) => line.includes(appPasswordUrl))).toBe(true);
  });

  it("accepting the open-browser offer opens exactly the printed, account-pinned app-password URL", async () => {
    const { io } = captureIo({ configDir: workdir });
    const openedUrls: string[] = [];
    const result = await runEmailSetup(io, {
      ...apppassword,
      confirmOpenBrowser: async () => true,
      openBrowser: (url) => { openedUrls.push(url); },
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@gmail.com",
      verifyImapConnection: async () => ({ messageCount: 0, ok: true })
    });
    expect(result.ok).toBe(true);
    expect(openedUrls).toEqual([buildGmailAppPasswordUrls("user@gmail.com").appPasswordUrl]);
  });

  it("a Korean webmail domain (Naver, Daum, Kakao, Hanmail) shows only that provider's short note, never Google's wall", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...apppassword,
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@daum.net",
      promptImapHost: async () => undefined,
      promptSmtpHost: async () => undefined,
      verifyImapConnection: async () => ({ messageCount: 0, ok: true })
    });
    expect(result.ok).toBe(true);
    const printed = lines.join("");
    expect(printed).toContain("Daum Mail");
    expect(printed).not.toContain("myaccount.google.com");
  });
});

describe("classifyEmailProvider — domain branching (AC1's routing table)", () => {
  it("gmail.com routes to the gmail branch", () => {
    expect(classifyEmailProvider("user@gmail.com")).toEqual({ kind: "gmail" });
  });

  it("googlemail.com (Gmail's alternate domain) also routes to the gmail branch", () => {
    expect(classifyEmailProvider("user@googlemail.com")).toEqual({ kind: "gmail" });
  });

  it("naver.com routes to ko-webmail WITH verified imap.naver.com/smtp.naver.com host prefill", () => {
    expect(classifyEmailProvider("user@naver.com")).toEqual({
      imapHost: "imap.naver.com", kind: "ko-webmail", label: expect.stringContaining("Naver"), smtpHost: "smtp.naver.com"
    });
  });

  it("an unlisted domain routes to the generic branch (today's bare host prompts)", () => {
    expect(classifyEmailProvider("user@example.com")).toEqual({ kind: "generic" });
  });

  it("is case-insensitive on the domain", () => {
    expect(classifyEmailProvider("USER@GMAIL.COM")).toEqual({ kind: "gmail" });
  });
});

describe("buildGmailAppPasswordUrls — authuser pinning + URL encoding", () => {
  it("pins both URLs to the exact typed address via authuser", () => {
    const { appPasswordUrl, twoStepUrl } = buildGmailAppPasswordUrls("user@gmail.com");
    expect(new URL(appPasswordUrl).searchParams.get("authuser")).toBe("user@gmail.com");
    expect(new URL(twoStepUrl).searchParams.get("authuser")).toBe("user@gmail.com");
    expect(appPasswordUrl.startsWith("https://myaccount.google.com/apppasswords?")).toBe(true);
  });

  it("an address containing '+' round-trips through the query string intact (never decoded as a space)", () => {
    const email = "user+tag@gmail.com";
    const { appPasswordUrl } = buildGmailAppPasswordUrls(email);
    expect(appPasswordUrl).toContain("authuser=user%2Btag%40gmail.com");
    expect(new URL(appPasswordUrl).searchParams.get("authuser")).toBe(email);
  });
});

describe("runGmailOAuthLoopback — client preflight", () => {
  it("aborts BEFORE opening any browser or binding the callback server when Google rejects the client id", async () => {
    const openedUrls: string[] = [];
    let serverStarted = false;
    let exchangeCalled = false;
    const printed: string[] = [];
    const result = await runGmailOAuthLoopback({
      clientId: "bad.apps.googleusercontent.com",
      clientSecret: "csecret",
      exchangeCode: async () => {
        exchangeCalled = true;
        return { accessToken: "x", expiresAt: 0, refreshToken: "y" };
      },
      openBrowser: (url) => { openedUrls.push(url); },
      preflightClient: async () => ({ errorCode: "invalid_client", message: "The OAuth client was not found.", ok: false }),
      startCallbackServer: async () => {
        serverStarted = true;
        return { close: async () => undefined, port: 1, waitForCode: async () => ({ code: "never" }) };
      },
      stdout: (message) => { printed.push(message); }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid_client");
      expect(result.reason).toContain("The OAuth client was not found.");
    }
    expect(openedUrls).toHaveLength(0);
    expect(serverStarted).toBe(false);
    expect(exchangeCalled).toBe(false);
    expect(printed.join("")).toContain("console.cloud.google.com/auth/clients");
  });
});

describe("runEmailSetup — client_secret_*.json input (no hand-pasting)", () => {
  let workdir: string;
  const oauth = { promptMethod: async () => "oauth" as const };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-setup-email-json-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  const installedJson = JSON.stringify({
    installed: { client_id: "json-cid.apps.googleusercontent.com", client_secret: "GOCSPX-json-secret" }
  });

  it("a .json path resolves ID + secret from the file; the secret prompt is never shown", async () => {
    const { io } = captureIo({ configDir: workdir });
    const server = fakeCallbackServer({ code: "auth-code-1" });
    let secretPrompted = false;
    const result = await runEmailSetup(io, {
      ...oauth,
      exchangeCode: async (args) => {
        expect(args.clientId).toBe("json-cid.apps.googleusercontent.com");
        expect(args.clientSecret).toBe("GOCSPX-json-secret");
        return { accessToken: "at-1", expiresAt: Date.now() + 3600_000, refreshToken: "rt-1" };
      },
      promptClientId: async () => "~/Downloads/client_secret_x.json",
      promptClientSecret: async () => { secretPrompted = true; return "should-not-be-used"; },
      readFileImpl: async (path) => {
        expect(path.endsWith("/Downloads/client_secret_x.json")).toBe(true);
        expect(path.startsWith("~")).toBe(false);
        return installedJson;
      },
      startCallbackServer: server.start
    });
    expect(result.ok).toBe(true);
    expect(secretPrompted).toBe(false);
    const stored = await readGmailCredential(io);
    expect(stored?.clientId).toBe("json-cid.apps.googleusercontent.com");
    expect(stored?.clientSecret).toBe("GOCSPX-json-secret");
  });

  it("pasted JSON content works without any file read", async () => {
    const { io } = captureIo({ configDir: workdir });
    const server = fakeCallbackServer({ code: "auth-code-1" });
    const result = await runEmailSetup(io, {
      ...oauth,
      exchangeCode: async () => ({ accessToken: "at-1", expiresAt: Date.now() + 3600_000, refreshToken: "rt-1" }),
      promptClientId: async () => installedJson,
      startCallbackServer: server.start
    });
    expect(result.ok).toBe(true);
    expect((await readGmailCredential(io))?.clientId).toBe("json-cid.apps.googleusercontent.com");
  });

  it("a Web-application JSON aborts with the Desktop-app remedy and stores NOTHING", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...oauth,
      promptClientId: async () => JSON.stringify({ web: { client_id: "x.apps.googleusercontent.com", client_secret: "s" } })
    });
    expect(result.ok).toBe(false);
    expect(lines.some((line) => line.includes("Desktop app"))).toBe(true);
    expect(await readGmailCredential(io)).toBeUndefined();
  });

  it("an unreadable path aborts cleanly with the path in the message", async () => {
    const { io, lines } = captureIo({ configDir: workdir });
    const result = await runEmailSetup(io, {
      ...oauth,
      promptClientId: async () => "/nope/missing.json",
      readFileImpl: async () => { throw new Error("ENOENT"); }
    });
    expect(result.ok).toBe(false);
    expect(lines.some((line) => line.includes("/nope/missing.json"))).toBe(true);
    expect(await readGmailCredential(io)).toBeUndefined();
  });
});

describe("muse setup email — KO rendering (AC4: language=ko reads natural Korean, never the pre-language dual '한국어 · English' format)", () => {
  let workdir: string;
  const koEnv = { MUSE_LANG: "ko" };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "muse-setup-email-ko-"));
  });
  afterEach(async () => {
    await rm(workdir, { force: true, recursive: true });
  });

  it("runEmailSetup resolves the language BEFORE the method-select prompt runs, so defaultPromptMethod's t() calls already read Korean", async () => {
    const { io } = captureIo({ configDir: workdir, env: koEnv });
    // Cancel at the method prompt itself (never touches the real @clack/prompts
    // select, which would hang for real input under vitest) — the point is
    // that `ensureLanguageResolved` runs BEFORE that prompt is reached.
    await runEmailSetup(io, { promptMethod: async () => undefined });
    const { getCliLanguage, t } = await import("./cli-i18n.js");
    expect(getCliLanguage()).toBe("ko");
    expect(t("email.method.prompt")).toBe("이메일을 어떻게 연결할까요?");
  });

  it("the App Password happy path (Gmail) renders the Korean success line and Korean app-password step, never the English wording", async () => {
    const { io, lines } = captureIo({ configDir: workdir, env: koEnv });
    const result = await runAppPasswordEmailSetup(io, {
      confirmOpenBrowser: async () => false,
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@gmail.com",
      verifyImapConnection: async () => ({ messageCount: 3, ok: true })
    });
    expect(result.ok).toBe(true);
    const printed = lines.join("");
    expect(printed).toContain("앱 비밀번호 생성 페이지");
    expect(printed).toContain("연결됨 — 받은편지함에 메시지 3개");
    expect(printed).not.toContain("Opening the app-password page");
    expect(printed).not.toContain("✓ connected");
  });

  it("a Korean webmail note renders as a single Korean sentence, not the old bilingual '· English' dual line", async () => {
    const { io, lines } = captureIo({ configDir: workdir, env: koEnv });
    const result = await runAppPasswordEmailSetup(io, {
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@daum.net",
      promptImapHost: async () => undefined,
      promptSmtpHost: async () => undefined,
      verifyImapConnection: async () => ({ messageCount: 0, ok: true })
    });
    expect(result.ok).toBe(true);
    const printed = lines.join("");
    expect(printed).toContain("Daum Mail");
    expect(printed).toContain("메일 설정에서 IMAP 사용을 켜고");
    expect(printed).not.toContain("in that provider's mail security settings");
  });

  it("a verify failure renders CODE-driven Korean guidance (AC3), never the package's raw English message", async () => {
    const { ImapSmtpAuthError } = await import("@muse/domain-tools");
    const { io, lines } = captureIo({ configDir: workdir, env: koEnv });
    const result = await runAppPasswordEmailSetup(io, {
      promptAppPassword: async () => "pw",
      promptEmail: async () => "user@gmail.com",
      verifyImapConnection: async () => ({
        error: new ImapSmtpAuthError("IMAP login rejected for user@gmail.com — application-specific password required", "app-password-required"),
        ok: false
      })
    });
    expect(result.ok).toBe(false);
    const printed = lines.join("");
    expect(printed).toContain("일반 로그인 비밀번호를 입력하셨어요");
    expect(printed).toContain("myaccount.google.com/apppasswords?authuser=user%40gmail.com");
    expect(printed).not.toContain("IMAP login rejected");
  });
});

describe("defaultOpenBrowser — the real-browser guard (a test must NEVER pop the owner's browser)", () => {
  it("is a hard no-op under vitest even with a spawn impl injected", async () => {
    const { defaultOpenBrowser } = await import("./setup-email.js");
    const calls: string[][] = [];
    const fakeSpawn = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { on: () => undefined } as never;
    }) as never;
    defaultOpenBrowser("https://accounts.google.com/o/oauth2/v2/auth?should=never-open", fakeSpawn);
    expect(calls).toEqual([]);
  });
});
