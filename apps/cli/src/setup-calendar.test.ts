import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { generateOAuthState, generatePkcePair } from "./setup-calendar.js";

describe("generateOAuthState — CSRF state token for the `muse setup calendar` Google OAuth loopback flow uses crypto.randomBytes, not Math.random, so a localhost-only attacker can't predict the state from a few observed outputs and replay-bind a victim's account", () => {
  it("returns a 32-character lowercase-hex string — 16 random bytes × 2 hex digits, giving 128 bits of entropy", () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("emits a distinct value on every call so the per-flow nonce can't be inferred from a prior run's output", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      samples.add(generateOAuthState());
    }
    expect(samples.size).toBe(50);
  });
});

describe("generatePkcePair — RFC 7636 Proof Key for Code Exchange so an attacker who intercepts the OAuth authorization code (e.g., from a same-host process logging the redirect URL) still can't redeem it for tokens without also possessing the per-flow code_verifier the CLI keeps in-memory", () => {
  it("emits a 43-character base64url-safe verifier (32 random bytes → 43 chars unpadded base64url) — the RFC 7636 lower bound is 43, our verifier sits at exactly that", () => {
    const pair = generatePkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("emits a 43-character base64url challenge whose decoded bytes equal SHA-256(verifier) — pre-fix Google would either reject the missing code_challenge or accept any verifier, defeating the PKCE binding", () => {
    const pair = generatePkcePair();
    const expectedChallenge = createHash("sha256").update(pair.verifier).digest("base64url");
    expect(pair.challenge).toBe(expectedChallenge);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("pins method to S256 so the auth URL advertises the right code_challenge_method — `plain` would let an attacker who steals the challenge alone derive a working verifier", () => {
    expect(generatePkcePair().method).toBe("S256");
  });

  it("emits a distinct verifier + challenge on every call so the per-flow PKCE binding can't be reused across sessions", () => {
    const verifiers = new Set<string>();
    const challenges = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const pair = generatePkcePair();
      verifiers.add(pair.verifier);
      challenges.add(pair.challenge);
    }
    expect(verifiers.size).toBe(50);
    expect(challenges.size).toBe(50);
  });
});

describe("preflightGoogleCalendarClient — a dead client ID is explained in the terminal BEFORE any browser opens (the same 401 invalid_client class the email wizard already guards)", () => {
  const realAuthErrorBlob = "Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw";

  const makeIo = (fetchImpl: typeof fetch) => {
    const errors: string[] = [];
    const outs: string[] = [];
    return {
      errors,
      io: {
        fetchImpl,
        stderr: (m: string) => { errors.push(m); },
        stdout: (m: string) => { outs.push(m); }
      },
      outs
    };
  };

  it("returns false and prints the calendar-wizard guidance when Google rejects the client before consent", async () => {
    const { preflightGoogleCalendarClient } = await import("./setup-calendar.js");
    const fetchImpl = (async () => ({
      headers: new Headers({
        location: `https://accounts.google.com/signin/oauth/error?authError=${realAuthErrorBlob}&flowName=GeneralOAuthFlow`
      }),
      status: 302
    } as unknown as Response)) as unknown as typeof fetch;
    const { errors, io } = makeIo(fetchImpl);

    await expect(preflightGoogleCalendarClient("dead.apps.googleusercontent.com", io)).resolves.toBe(false);
    const all = errors.join("");
    expect(all).toContain("`muse setup calendar`");
    expect(all).toContain("invalid_client");
  });

  it("returns true and prints nothing when the client is accepted", async () => {
    const { preflightGoogleCalendarClient } = await import("./setup-calendar.js");
    const fetchImpl = (async () => ({
      headers: new Headers({ location: "https://accounts.google.com/v3/signin/identifier" }),
      status: 302
    } as unknown as Response)) as unknown as typeof fetch;
    const { errors, io, outs } = makeIo(fetchImpl);

    await expect(preflightGoogleCalendarClient("live.apps.googleusercontent.com", io)).resolves.toBe(true);
    expect(errors).toEqual([]);
    expect(outs).toEqual([]);
  });
});
