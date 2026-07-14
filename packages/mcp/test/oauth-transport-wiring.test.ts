import { describe, expect, it } from "vitest";

import { resolveOAuthProviderForServer, serverUsesOAuth } from "../src/transport.js";
import type { McpServer } from "../src/index.js";

function server(config: Record<string, unknown>, transportType: McpServer["transportType"] = "streamable"): McpServer {
  return {
    autoConnect: true,
    config,
    createdAt: new Date(),
    id: "random-runtime-id",
    name: "github-remote",
    transportType,
    updatedAt: new Date()
  };
}

const OAUTH_CONFIG = { dir: "/tmp/muse-oauth-wiring", redirectPort: 33418 };

describe("serverUsesOAuth", () => {
  it("is true for a remote server with config.auth === 'oauth'", () => {
    expect(serverUsesOAuth(server({ auth: "oauth", url: "https://x/mcp" }))).toBe(true);
    expect(serverUsesOAuth(server({ auth: "OAuth", url: "https://x/mcp" }, "sse"))).toBe(true);
  });

  it("is false without the opt-in field", () => {
    expect(serverUsesOAuth(server({ url: "https://x/mcp" }))).toBe(false);
    expect(serverUsesOAuth(server({ auth: "bearer", url: "https://x/mcp" }))).toBe(false);
  });

  it("is false for a stdio server even if it declares auth", () => {
    expect(serverUsesOAuth(server({ auth: "oauth", command: "npx" }, "stdio"))).toBe(false);
  });
});

describe("resolveOAuthProviderForServer", () => {
  it("returns an authProvider when the server opts into OAuth and oauth is configured", () => {
    const provider = resolveOAuthProviderForServer(server({ auth: "oauth", url: "https://x/mcp" }), OAUTH_CONFIG, "Muse");
    expect(provider).toBeDefined();
    // keyed by the STABLE server name so login + runtime agree
    expect(provider?.redirectUrl).toBe("http://127.0.0.1:33418/callback");
  });

  it("returns undefined for a non-OAuth server (transport stays header/token-only)", () => {
    expect(resolveOAuthProviderForServer(server({ url: "https://x/mcp" }), OAUTH_CONFIG, "Muse")).toBeUndefined();
  });

  it("returns undefined when oauth is not configured on the connector", () => {
    expect(resolveOAuthProviderForServer(server({ auth: "oauth", url: "https://x/mcp" }), undefined, "Muse")).toBeUndefined();
  });

  it("the RUNTIME provider never opens a browser: redirectToAuthorization throws 'run muse mcp login'", async () => {
    const provider = resolveOAuthProviderForServer(server({ auth: "oauth", url: "https://x/mcp" }), OAUTH_CONFIG, "Muse");
    // A headless daemon connect with no stored tokens must fail-closed with
    // guidance, never spawn the user's browser mid-connect.
    await expect(provider!.redirectToAuthorization(new URL("https://as.example/authorize"))).rejects.toThrow(/muse mcp login/);
  });
});
