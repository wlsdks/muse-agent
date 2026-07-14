import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMcpOAuthLogin } from "../src/oauth-login.js";
import { loadClientInformation, loadTokens } from "../src/oauth-store.js";

/**
 * Contract-faithful mock OAuth 2.1 authorization server. It implements the
 * real discovery → DCR → token-exchange contract (RFC 9728 protected-resource
 * metadata, RFC 8414 AS metadata, RFC 7591 dynamic client registration, and
 * the authorization_code + PKCE token endpoint) so the SDK's real `auth()`
 * drives against it end-to-end. This proves Muse's provider + callback server
 * complete the full flow without a real IdP.
 */
interface MockAuthServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
  readonly tokenRequests: URLSearchParams[];
  readonly registrations: unknown[];
}

async function startMockAuthServer(): Promise<MockAuthServer> {
  const tokenRequests: URLSearchParams[] = [];
  const registrations: unknown[] = [];
  let origin = "";

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      json(200, { authorization_servers: [origin], resource: `${origin}/mcp` });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(200, {
        authorization_endpoint: `${origin}/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: origin,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        token_endpoint: `${origin}/token`,
        token_endpoint_auth_methods_supported: ["none"]
      });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { redirect_uris?: string[] };
        registrations.push(body);
        json(201, {
          client_id: "mock-client-id",
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: body.redirect_uris ?? [],
          token_endpoint_auth_method: "none"
        });
      });
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        tokenRequests.push(new URLSearchParams(raw));
        json(200, {
          access_token: "mock-access-token",
          expires_in: 3600,
          refresh_token: "mock-refresh-token",
          token_type: "Bearer"
        });
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port.toString()}`;

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    origin,
    registrations,
    tokenRequests
  };
}

let dir: string;
let auth: MockAuthServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "muse-oauth-flow-"));
  auth = await startMockAuthServer();
});

afterEach(async () => {
  await auth.close();
  rmSync(dir, { force: true, recursive: true });
});

describe("runMcpOAuthLogin end-to-end against a mock authorization server", () => {
  it("drives discovery → DCR → PKCE exchange and persists the tokens", async () => {
    // The injected opener plays the user's browser + the AS's redirect: it
    // reads the state the SDK embedded and redirects back to the loopback
    // callback with a code, exactly as a real AS would after consent.
    const openBrowser = async (authorizationUrl: string): Promise<void> => {
      const u = new URL(authorizationUrl);
      const state = u.searchParams.get("state") ?? "";
      const redirectUri = u.searchParams.get("redirect_uri") ?? "";
      const back = `${redirectUri}?code=mock-auth-code&state=${encodeURIComponent(state)}`;
      const res = await fetch(back);
      await res.text();
    };

    const result = await runMcpOAuthLogin({
      clientName: "Muse",
      env: {},
      oauthDir: dir,
      openBrowser,
      scopes: ["repo"],
      serverId: "github-remote",
      serverUrl: `${auth.origin}/mcp`,
      timeoutMs: 10_000
    });

    expect(result).toEqual({ serverId: "github-remote", status: "authorized" });

    // DCR persisted a public client keyed to our loopback redirect.
    const client = await loadClientInformation(dir, "github-remote");
    expect(client?.client_id).toBe("mock-client-id");
    expect(client?.redirect_uris?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);

    // Tokens landed in the store.
    const tokens = await loadTokens(dir, "github-remote");
    expect(tokens?.access_token).toBe("mock-access-token");
    expect(tokens?.refresh_token).toBe("mock-refresh-token");

    // The token exchange carried the PKCE verifier + the auth code (proof the
    // PKCE round-trip completed, not just that a token came back).
    expect(auth.tokenRequests).toHaveLength(1);
    const tokenReq = auth.tokenRequests[0];
    expect(tokenReq?.get("grant_type")).toBe("authorization_code");
    expect(tokenReq?.get("code")).toBe("mock-auth-code");
    expect(tokenReq?.get("code_verifier")).toBeTruthy();
    expect(tokenReq?.get("redirect_uri")).toMatch(/\/callback$/u);
  });
});
