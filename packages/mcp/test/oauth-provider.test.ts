import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MuseMcpOAuthProvider } from "../src/oauth-provider.js";
import { loadState } from "../src/oauth-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-oauth-provider-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function makeProvider(overrides: Partial<ConstructorParameters<typeof MuseMcpOAuthProvider>[0]> = {}) {
  return new MuseMcpOAuthProvider({
    clientName: "Muse",
    oauthDir: dir,
    redirectPort: 33418,
    scopes: ["repo", "read:user"],
    serverId: "github-remote",
    ...overrides
  });
}

describe("MuseMcpOAuthProvider redirect port validation", () => {
  it("rejects invalid loopback ports before producing an OAuth redirect URL", () => {
    for (const redirectPort of [0, -1, 65_536, Number.NaN, Number.POSITIVE_INFINITY, 33418.5]) {
      expect(() => makeProvider({ redirectPort })).toThrow(RangeError);
    }
  });
});

describe("MuseMcpOAuthProvider clientMetadata", () => {
  it("declares a public client + PKCE with a loopback redirect", () => {
    const meta = makeProvider().clientMetadata;
    expect(meta.redirect_uris).toEqual(["http://127.0.0.1:33418/callback"]);
    expect(meta.token_endpoint_auth_method).toBe("none");
    expect(meta.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.response_types).toEqual(["code"]);
    expect(meta.scope).toBe("repo read:user");
    expect(meta).not.toHaveProperty("client_secret");
  });

  it("omits scope when none configured", () => {
    expect(makeProvider({ scopes: undefined }).clientMetadata.scope).toBeUndefined();
  });

  it("redirectUrl is loopback-only", () => {
    expect(makeProvider().redirectUrl).toBe("http://127.0.0.1:33418/callback");
  });
});

describe("MuseMcpOAuthProvider state (CSRF)", () => {
  it("returns a fresh random state and PERSISTS it for the callback to validate", async () => {
    const provider = makeProvider();
    const value = await provider.state();
    expect(value).toBeTruthy();
    expect(await loadState(dir, "github-remote")).toBe(value);
  });

  it("uses the injected randomState in tests", async () => {
    const provider = makeProvider({ randomState: () => "fixed-state-123" });
    expect(await provider.state()).toBe("fixed-state-123");
  });
});

describe("MuseMcpOAuthProvider codeVerifier contract", () => {
  it("throws a clear error when no verifier is saved", async () => {
    await expect(makeProvider().codeVerifier()).rejects.toThrow(/code verifier/i);
  });

  it("round-trips a saved verifier", async () => {
    const provider = makeProvider();
    await provider.saveCodeVerifier("verifier-xyz");
    expect(await provider.codeVerifier()).toBe("verifier-xyz");
  });
});

describe("MuseMcpOAuthProvider redirectToAuthorization", () => {
  it("calls the injected opener with the SDK's authorization URL — never auto-approves", async () => {
    const openBrowser = vi.fn();
    const provider = makeProvider({ openBrowser });
    const url = new URL("https://as.example.com/authorize?client_id=x&state=s");
    await provider.redirectToAuthorization(url);
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith(url.toString());
  });
});

describe("MuseMcpOAuthProvider invalidateCredentials", () => {
  it("clears persisted tokens on scope 'tokens'", async () => {
    const provider = makeProvider();
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.invalidateCredentials("tokens");
    expect(await provider.tokens()).toBeUndefined();
  });

  it("clears everything on scope 'all'", async () => {
    const provider = makeProvider();
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.saveCodeVerifier("v");
    await provider.invalidateCredentials("all");
    expect(await provider.tokens()).toBeUndefined();
    await expect(provider.codeVerifier()).rejects.toThrow();
  });

  it("no-ops on scope 'discovery' (not persisted by this store)", async () => {
    const provider = makeProvider();
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.invalidateCredentials("discovery");
    expect(await provider.tokens()).toEqual({ access_token: "at", token_type: "Bearer" });
  });
});
